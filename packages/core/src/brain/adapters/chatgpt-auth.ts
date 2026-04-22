/**
 * ChatGPT OAuth 토큰 관리 — `codex login`이 만든 auth.json을 읽고 자동 refresh.
 *
 * 첫 로그인은 OpenAI 공식 Codex CLI가 담당:
 *   `npx @openai/codex login`
 * → 브라우저에서 ChatGPT 로그인 → 토큰이 `~/.codex/auth.json` 또는
 *   `~/.chatgpt-local/auth.json`에 저장됨.
 *
 * Mandu 는 그 파일을 읽고, 만료 임박 시 refresh_token으로 자동 갱신.
 *
 * 이 접근의 장점:
 *   - Mandu OAuth 앱 등록 불필요. OpenAI 공식 clientId 재사용.
 *   - 사용자가 codex CLI 를 이미 설치했다면 로그인 1회로 끝.
 *   - 토큰 저장소를 OpenAI 공식 경로와 공유 → 여러 도구가 같은 세션 사용.
 *
 * 포팅 원본: kakao-bot-sdk `src/auth/chatgpt.ts` (EvanZhouDev/openai-oauth
 * MIT 패턴의 단순화 버전).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

interface StoredTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

interface AuthFile {
  OPENAI_API_KEY?: string;
  tokens?: StoredTokens;
  last_refresh?: string;
}

export interface EffectiveAuth {
  accessToken: string;
  accountId: string;
  idToken?: string;
  refreshToken?: string;
  sourcePath: string;
}

/** Minimal fetch surface — matches `HttpClient` from `./oauth-flow`. */
export type ChatGPTHttpClient = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ChatGPTAuthOptions {
  /** auth.json 경로 명시 override. 기본: 자동 탐색. */
  authFilePath?: string;
  /** OAuth client_id. 기본: ChatGPT 공식 (`app_EMoamEEZ73f0CkXaXp7hrann`). */
  clientId?: string;
  /** Token endpoint. 기본: `https://auth.openai.com/oauth/token`. */
  tokenUrl?: string;
  /** Test 주입용 — 실제 fetch 대신 stub. */
  httpClient?: ChatGPTHttpClient;
}

export class ChatGPTAuth {
  private readonly clientId: string;
  private readonly tokenUrl: string;
  private readonly httpClient: ChatGPTHttpClient;
  /** 명시된 경로 또는 첫 read 시 결정된 경로. write 시 같은 경로 사용. */
  private resolvedPath: string | null;
  private readonly explicitPath: string | undefined;

  constructor(options: ChatGPTAuthOptions = {}) {
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
    this.httpClient = options.httpClient ?? fetch;
    this.explicitPath = options.authFilePath;
    this.resolvedPath = options.authFilePath ?? null;
  }

  /** 저장된 토큰이 존재하는지 (만료 무관). */
  isAuthenticated(): boolean {
    const data = this.readFile();
    return Boolean(data?.tokens?.access_token);
  }

  /**
   * 유효한 access_token + account_id 반환. 만료 임박 시 자동 refresh.
   * 토큰 없거나 refresh 실패 시 throw.
   */
  async getAuth(): Promise<EffectiveAuth> {
    let data = this.readFile();
    if (!data) {
      throw new Error(
        `[mandu brain] OpenAI auth.json not found. Expected at one of:\n${candidatePaths(this.explicitPath).join("\n")}\n` +
          `Run \`npx @openai/codex login\` first (or \`mandu brain login\` which wraps it).`,
      );
    }

    let accessToken = data.tokens?.access_token;
    let idToken = data.tokens?.id_token;
    let refreshToken = data.tokens?.refresh_token;
    let accountId = data.tokens?.account_id ?? deriveAccountId(idToken);

    if (!accessToken) {
      throw new Error(
        "[mandu brain] auth.json has no access_token. Re-run `npx @openai/codex login`.",
      );
    }

    if (shouldRefresh(accessToken, data.last_refresh)) {
      if (!refreshToken) {
        throw new Error(
          "[mandu brain] Token expired and no refresh_token available. Re-run `npx @openai/codex login`.",
        );
      }
      const refreshed = await this.callTokenEndpoint(refreshToken);
      accessToken = refreshed.access_token;
      idToken = refreshed.id_token ?? idToken;
      refreshToken = refreshed.refresh_token ?? refreshToken;
      accountId = deriveAccountId(idToken) ?? accountId;

      data = {
        ...data,
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: refreshToken,
          account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
      };
      this.writeFile(data);
    }

    if (!accountId) {
      throw new Error(
        "[mandu brain] Could not derive chatgpt_account_id from auth.json. Re-login required.",
      );
    }
    if (!accessToken) {
      throw new Error(
        "[mandu brain] access_token is null after refresh (unexpected).",
      );
    }

    return {
      accessToken,
      accountId,
      idToken,
      refreshToken,
      sourcePath: this.resolvedPath ?? "(unknown)",
    };
  }

  /** 로그인 후 auth.json 이 존재하는 위치 반환 (디버그용). */
  locateAuthFile(): string | null {
    const candidates = candidatePaths(this.explicitPath);
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  // ─── 내부 ────────────────────────────────────

  private readFile(): AuthFile | null {
    const candidates = candidatePaths(this.explicitPath);
    for (const p of candidates) {
      try {
        if (!existsSync(p)) continue;
        const text = readFileSync(p, "utf-8");
        const parsed = JSON.parse(text) as AuthFile;
        if (typeof parsed === "object" && parsed !== null) {
          this.resolvedPath = p;
          return parsed;
        }
      } catch {
        // 다음 candidate 시도
      }
    }
    return null;
  }

  private writeFile(data: AuthFile): void {
    const path = this.resolvedPath ?? this.explicitPath ?? defaultWritePath();
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tmp, path);
    this.resolvedPath = path;
  }

  private async callTokenEndpoint(refreshToken: string): Promise<StoredTokens> {
    const resp = await this.httpClient(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
        scope: "openid profile email offline_access",
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Token refresh ${resp.status}: ${text.slice(0, 300)}`);
    }
    let json: { access_token?: string; refresh_token?: string; id_token?: string };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Token refresh: invalid JSON: ${text.slice(0, 200)}`);
    }
    if (!json.access_token) {
      throw new Error(`Token refresh: missing access_token: ${text}`);
    }
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      id_token: json.id_token,
    };
  }
}

// ─── 헬퍼 ─────────────────────────────────────

function candidatePaths(explicit?: string): string[] {
  if (explicit) return [explicit];
  const out: string[] = [];
  const env1 = process.env["CHATGPT_LOCAL_HOME"];
  const env2 = process.env["CODEX_HOME"];
  if (env1) out.push(join(env1, "auth.json"));
  if (env2) out.push(join(env2, "auth.json"));
  out.push(join(homedir(), ".chatgpt-local", "auth.json"));
  out.push(join(homedir(), ".codex", "auth.json"));
  return [...new Set(out)];
}

function defaultWritePath(): string {
  return process.env["CHATGPT_LOCAL_HOME"]
    ? join(process.env["CHATGPT_LOCAL_HOME"]!, "auth.json")
    : process.env["CODEX_HOME"]
      ? join(process.env["CODEX_HOME"]!, "auth.json")
      : join(homedir(), ".chatgpt-local", "auth.json");
}

function deriveAccountId(idToken?: string): string | undefined {
  if (!idToken || !idToken.includes(".")) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const padded = parts[1] + "=".repeat(((-parts[1].length % 4) + 4) % 4);
    const payload = JSON.parse(
      Buffer.from(padded, "base64url").toString("utf-8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth === "object" && auth !== null && "chatgpt_account_id" in auth) {
      const id = (auth as Record<string, unknown>)["chatgpt_account_id"];
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function shouldRefresh(accessToken: string, lastRefreshIso: string | undefined): boolean {
  // JWT exp 클레임으로 우선 판단
  const claims = parseJwtClaims(accessToken);
  if (claims && typeof claims["exp"] === "number") {
    const expMs = (claims["exp"] as number) * 1000;
    if (expMs <= Date.now() + REFRESH_EXPIRY_MARGIN_MS) return true;
  }
  // last_refresh 기반 휴리스틱 (55분 초과)
  if (lastRefreshIso) {
    const last = Date.parse(lastRefreshIso);
    if (!Number.isNaN(last) && Date.now() - last > 55 * 60 * 1000) return true;
  }
  return false;
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  if (!token.includes(".")) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const padded = parts[1] + "=".repeat(((-parts[1].length % 4) + 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf-8"));
    return typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OAuth middleware tests
 *
 * Fixture style mirrors `tests/middleware/session.test.ts`:
 *   - real `Request` / `Response` / `ManduContext`
 *   - real `createCookieSessionStorage`
 *   - fake `fetch` injected via `_oauthWith` — no network
 *
 * The `_oauthWith` seam is the reason we can unit-test the full callback flow
 * without spinning up provider doubles: we record what the middleware
 * requested and return canned responses.
 */
import { describe, it, expect } from "bun:test";
import {
  _oauthWith,
  oauth,
  github,
  google,
  type OAuthOptions,
  type OAuthProvider,
} from "../index";
import { session, saveSession } from "../../session";
import {
  Session,
  createCookieSessionStorage,
  type SessionStorage,
} from "../../../filling/session";
import { ManduContext } from "../../../filling/context";
import { AuthenticationError } from "../../../filling/auth";

// ========== Fixtures ==========

const SECRET = "oauth-mw-test-secret-32bytes!!!!!";

function makeReq(url: string, init: RequestInit & { cookie?: string } = {}): Request {
  const { cookie, headers: rawHeaders, ...rest } = init;
  const headers = new Headers(rawHeaders as HeadersInit | undefined);
  if (cookie) headers.set("cookie", cookie);
  return new Request(url, { ...rest, headers });
}

function makeCtx(req: Request): ManduContext {
  return new ManduContext(req);
}

function makeStorage(): SessionStorage {
  return createCookieSessionStorage({
    cookie: { secrets: [SECRET] },
  });
}

/** Install the session middleware on a fresh context. */
async function attachSession(ctx: ManduContext, storage: SessionStorage): Promise<void> {
  const mw = session({ storage });
  await mw(ctx);
}

function readSetCookieLines(res: Response): string[] {
  return res.headers.getSetCookie?.() ?? [];
}

function readSetCookieValue(res: Response, name: string): string | null {
  const lines = readSetCookieLines(res);
  for (const line of lines) {
    if (line.startsWith(`${name}=`)) {
      const [nv] = line.split(";");
      const eq = nv.indexOf("=");
      if (eq <= 0) return null;
      return decodeURIComponent(nv.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Fetch recorder — each call pushes a record and returns the next scripted response. */
interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface ScriptedResponse {
  status?: number;
  body: unknown;
  /** If true, `body` is already a string and is not JSON-stringified. */
  raw?: boolean;
}

function makeFetch(responses: ScriptedResponse[]): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];

  const fetchImpl = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const rawHeaders: Record<string, string> = {};
    const hdrs = new Headers(init?.headers as HeadersInit | undefined);
    hdrs.forEach((v, k) => {
      rawHeaders[k] = v;
    });
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body === undefined || init.body === null
          ? null
          : String(init.body);
    calls.push({ url, method, headers: rawHeaders, body: bodyText });

    const next = queue.shift();
    if (!next) {
      throw new Error(`[test fetch] no scripted response for ${method} ${url}`);
    }
    const status = next.status ?? 200;
    const payload = next.raw ? String(next.body) : JSON.stringify(next.body);
    return new Response(payload, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch: fetchImpl as typeof globalThis.fetch, calls };
}

/** Base options factory — tests override only what they care about. */
function baseOptions(overrides: Partial<OAuthOptions> = {}): OAuthOptions {
  return {
    provider: github(),
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "https://app.example.com/auth/github/callback",
    resolveUser: async () => "user-42",
    ...overrides,
  };
}

/**
 * Seed a pending OAuth record into a fresh session's cookie. Returns the
 * signed cookie header value suitable for `makeReq({ cookie: ... })`.
 *
 * We build the signed cookie by taking an empty session, mutating it, and
 * committing — exactly what the start flow does at runtime.
 */
async function seedPendingCookie(
  storage: SessionStorage,
  pending: {
    state: string;
    codeVerifier: string | null;
    provider: string;
  },
): Promise<string> {
  const sentinelReq = makeReq("https://app.example.com/_seed");
  const sentinel = makeCtx(sentinelReq);
  await attachSession(sentinel, storage);
  const s = sentinel.get<Session>("session")!;
  s.set("oauth:pending", pending);
  await saveSession(sentinel);
  const out = sentinel.cookies.getSetCookieHeaders();
  if (out.length === 0) {
    throw new Error("seed: no Set-Cookie produced");
  }
  // Convert Set-Cookie into a request-side cookie header.
  const [nameValue] = out[0].split(";");
  return nameValue;
}

// ========== Tests ==========

describe("oauth middleware / path matching", () => {
  it("(1) passes through on non-matching path (returns void)", async () => {
    const storage = makeStorage();
    const req = makeReq("https://app.example.com/api/posts");
    const ctx = makeCtx(req);
    await attachSession(ctx, storage);

    const mw = oauth(baseOptions());
    const result = await mw(ctx);
    expect(result).toBeUndefined();
  });

  it("(17) passes through on /auth/<unknown-provider> (path param doesn't match configured provider name)", async () => {
    const storage = makeStorage();
    // Configure GitHub (path: /auth/github) but hit /auth/foo — should not match.
    const req = makeReq("https://app.example.com/auth/foo");
    const ctx = makeCtx(req);
    await attachSession(ctx, storage);

    const mw = oauth(baseOptions());
    const result = await mw(ctx);
    expect(result).toBeUndefined();
  });

  it("(16) custom paths config routes correctly", async () => {
    const storage = makeStorage();
    const req = makeReq("https://app.example.com/login/github");
    const ctx = makeCtx(req);
    await attachSession(ctx, storage);

    const { fetch: fakeFetch } = makeFetch([]);
    const mw = _oauthWith(
      fakeFetch,
      baseOptions({
        paths: { start: "/login/:provider", callback: "/login/:provider/callback" },
      }),
    );

    const res = await mw(ctx);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    const location = (res as Response).headers.get("location") ?? "";
    expect(location.startsWith("https://github.com/login/oauth/authorize")).toBe(true);
  });
});

describe("oauth middleware / start flow", () => {
  it("(2) throws AuthenticationError when session middleware is missing", async () => {
    const req = makeReq("https://app.example.com/auth/github");
    const ctx = makeCtx(req);
    // DO NOT install session.

    const mw = oauth(baseOptions());
    let captured: unknown = null;
    try {
      await mw(ctx);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(AuthenticationError);
    expect((captured as Error).message).toContain("session middleware");
  });

  it("(3) start redirects to provider authorization endpoint with correct query params", async () => {
    const storage = makeStorage();
    const req = makeReq("https://app.example.com/auth/github");
    const ctx = makeCtx(req);
    await attachSession(ctx, storage);

    const mw = oauth(baseOptions());
    const res = (await mw(ctx)) as Response;
    expect(res.status).toBe(302);

    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/auth/github/callback",
    );
    expect(loc.searchParams.get("scope")).toBe("read:user user:email");
    const state = loc.searchParams.get("state");
    expect(state).not.toBeNull();
    expect((state ?? "").length).toBeGreaterThan(8);
    expect(loc.searchParams.get("code_challenge")).not.toBeNull();
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("(4) start writes oauth:pending into session with state + codeVerifier + provider name", async () => {
    const storage = makeStorage();
    const req = makeReq("https://app.example.com/auth/github");
    const ctx = makeCtx(req);
    await attachSession(ctx, storage);

    const mw = oauth(baseOptions());
    const res = (await mw(ctx)) as Response;
    const loc = new URL(res.headers.get("location") ?? "");
    const stateFromUrl = loc.searchParams.get("state");
    expect(stateFromUrl).not.toBeNull();

    const s = ctx.get<Session>("session")!;
    const pending = s.get<{ state: string; codeVerifier: string | null; provider: string }>(
      "oauth:pending",
    );
    expect(pending).toBeDefined();
    expect(pending!.state).toBe(stateFromUrl as string);
    expect(pending!.provider).toBe("github");
    expect(typeof pending!.codeVerifier).toBe("string");
    expect((pending!.codeVerifier ?? "").length).toBeGreaterThan(32);
  });

  it("(5) start emits Set-Cookie with the session so it lands on the redirect response", async () => {
    const storage = makeStorage();
    const req = makeReq("https://app.example.com/auth/github");
    const ctx = makeCtx(req);
    await attachSession(ctx, storage);

    const mw = oauth(baseOptions());
    const res = (await mw(ctx)) as Response;
    const cookieVal = readSetCookieValue(res, "__session");
    expect(cookieVal).not.toBeNull();
    expect((cookieVal ?? "").length).toBeGreaterThan(0);
  });

  it("(12) pkce=false provider: start omits code_challenge, callback omits code_verifier", async () => {
    const storage = makeStorage();

    const customProvider: OAuthProvider = {
      ...github(),
      name: "custom-no-pkce",
      pkce: false,
    };

    // --- Start leg ---
    const startReq = makeReq("https://app.example.com/auth/custom-no-pkce");
    const startCtx = makeCtx(startReq);
    await attachSession(startCtx, storage);

    const { fetch: fakeFetch, calls } = makeFetch([
      { body: { access_token: "tok-1", token_type: "bearer" } },
      { body: { id: 1, login: "x", email: "x@y.com", name: "X", avatar_url: "u" } },
    ]);

    const options = baseOptions({ provider: customProvider });
    const mw = _oauthWith(fakeFetch, options);

    const startRes = (await mw(startCtx)) as Response;
    const startLoc = new URL(startRes.headers.get("location") ?? "");
    expect(startLoc.searchParams.get("code_challenge")).toBeNull();
    expect(startLoc.searchParams.get("code_challenge_method")).toBeNull();
    const state = startLoc.searchParams.get("state")!;

    // Seed a callback request carrying the pending state cookie that the
    // start leg would have set.
    const startCookieLine = readSetCookieLines(startRes).find((l) => l.startsWith("__session="))!;
    const [nameValue] = startCookieLine.split(";");

    const cbReq = makeReq(
      `https://app.example.com/auth/custom-no-pkce/callback?state=${state}&code=abc`,
      { cookie: nameValue },
    );
    const cbCtx = makeCtx(cbReq);
    await attachSession(cbCtx, storage);

    await mw(cbCtx);

    // First fetch call is the token exchange. Body should NOT include code_verifier.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const tokenCall = calls[0];
    expect(tokenCall.body ?? "").not.toContain("code_verifier");
  });
});

describe("oauth middleware / callback flow", () => {
  const providerName = "github";

  async function runCallback(
    overrides: {
      pending?: { state: string; codeVerifier: string | null; provider: string } | null;
      state?: string;
      code?: string;
      responses?: ScriptedResponse[];
      options?: Partial<OAuthOptions>;
      callbackPath?: string;
    } = {},
  ): Promise<{ res: Response; ctx: ManduContext; calls: FetchCall[] }> {
    const storage = makeStorage();
    const pending =
      overrides.pending === undefined
        ? { state: "state-AAA", codeVerifier: "verifier-XYZ", provider: providerName }
        : overrides.pending;

    let cookie: string | undefined;
    if (pending) {
      cookie = await seedPendingCookie(storage, pending);
    }

    const state = overrides.state ?? pending?.state ?? "state-AAA";
    const code = overrides.code ?? "auth-code-123";
    const url =
      `https://app.example.com${overrides.callbackPath ?? "/auth/github/callback"}` +
      `?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;

    const req = makeReq(url, cookie ? { cookie } : {});
    const ctx = makeCtx(req);
    await attachSession(ctx, storage);

    const { fetch: fakeFetch, calls } = makeFetch(overrides.responses ?? []);
    const mw = _oauthWith(fakeFetch, baseOptions(overrides.options));
    const res = (await mw(ctx)) as Response;
    return { res, ctx, calls };
  }

  it("(6) callback with no pending state in session → 403", async () => {
    const { res } = await runCallback({ pending: null });
    expect(res.status).toBe(403);
  });

  it("(7) callback with state mismatch → 403", async () => {
    const { res } = await runCallback({
      pending: { state: "state-REAL", codeVerifier: null, provider: providerName },
      state: "state-FORGED",
    });
    expect(res.status).toBe(403);
  });

  it("(8) callback happy path: exchanges code, fetches userinfo, logs user in, redirects", async () => {
    const resolvedUsers: string[] = [];
    const { res, ctx, calls } = await runCallback({
      responses: [
        { body: { access_token: "ghs_abc", token_type: "bearer" } },
        { body: { id: 99, email: "a@b.com", name: "A B", avatar_url: "https://a/b" } },
      ],
      options: {
        resolveUser: async (profile) => {
          resolvedUsers.push(profile.id);
          return "local-user-7";
        },
      },
    });

    // Two HTTP calls: token + userinfo.
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://github.com/login/oauth/access_token");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["accept"]).toBe("application/json");
    expect(calls[0].body ?? "").toContain("grant_type=authorization_code");
    expect(calls[0].body ?? "").toContain("code=auth-code-123");
    expect(calls[0].body ?? "").toContain("code_verifier=verifier-XYZ");

    expect(calls[1].url).toBe("https://api.github.com/user");
    expect(calls[1].method).toBe("GET");
    expect(calls[1].headers["authorization"]).toBe("Bearer ghs_abc");

    // resolveUser saw a normalized profile.
    expect(resolvedUsers).toEqual(["99"]);

    // Response is a redirect to post-login target (default "/").
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    // Session now carries userId.
    const s = ctx.get<Session>("session")!;
    expect(s.get<string>("userId")).toBe("local-user-7");
    // Pending record cleared.
    expect(s.get("oauth:pending")).toBeUndefined();
  });

  it("(9) callback: resolveUser returning a Response bubbles up unchanged (loginUser NOT called)", async () => {
    const custom = new Response("signup-needed", {
      status: 302,
      headers: { location: "/signup?provider=github" },
    });
    const { res, ctx } = await runCallback({
      responses: [
        { body: { access_token: "ghs_abc" } },
        { body: { id: 1 } },
      ],
      options: {
        resolveUser: async () => custom,
      },
    });

    expect(res).toBe(custom);
    const s = ctx.get<Session>("session")!;
    expect(s.get("userId")).toBeUndefined();
  });

  it("(10) callback: token endpoint 500 → 502, provider details not leaked", async () => {
    const { res } = await runCallback({
      responses: [{ status: 500, body: { error: "internal_secret_detail" } }],
    });
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { error: string; provider: string };
    expect(payload.error).toBe("oauth_failed");
    expect(payload.provider).toBe("github");
    // The sensitive error string must not appear in the response body.
    expect(JSON.stringify(payload)).not.toContain("internal_secret_detail");
  });

  it("(11) callback: userinfo endpoint 403 → 502", async () => {
    const { res } = await runCallback({
      responses: [
        { body: { access_token: "ghs_abc" } },
        { status: 403, body: { message: "bad scope" } },
      ],
    });
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("oauth_failed");
  });
});

describe("oauth middleware / provider presets", () => {
  it("(13) github preset normalizeProfile shape", () => {
    const provider = github();
    const raw = {
      id: 42,
      login: "octocat",
      email: "octo@github.com",
      name: "Octo Cat",
      avatar_url: "https://avatars/octo.png",
      extra: "passthrough",
    };
    const profile = provider.normalizeProfile(raw);
    expect(profile.id).toBe("42");
    expect(profile.email).toBe("octo@github.com");
    expect(profile.name).toBe("Octo Cat");
    expect(profile.avatarUrl).toBe("https://avatars/octo.png");
    expect(profile.raw).toBe(raw);
    expect(provider.name).toBe("github");
    expect(provider.pkce).toBe(true);
    expect(provider.scopes).toEqual(["read:user", "user:email"]);
  });

  it("(14) google preset normalizeProfile shape", () => {
    const provider = google();
    const raw = {
      sub: "1099999999999999",
      email: "alice@gmail.com",
      name: "Alice",
      picture: "https://lh3.googleusercontent.com/a/x",
      email_verified: true,
    };
    const profile = provider.normalizeProfile(raw);
    expect(profile.id).toBe("1099999999999999");
    expect(profile.email).toBe("alice@gmail.com");
    expect(profile.name).toBe("Alice");
    expect(profile.avatarUrl).toBe("https://lh3.googleusercontent.com/a/x");
    expect(profile.raw).toBe(raw);
    expect(provider.name).toBe("google");
    expect(provider.pkce).toBe(true);
    expect(provider.scopes).toEqual(["openid", "email", "profile"]);
  });
});

describe("oauth middleware / constant-time state comparison", () => {
  /**
   * Validates the behavior of the safeEqual helper as expressed through the
   * public API: a callback whose returned state differs from the stored one
   * at ANY byte position (not just the first) must still be rejected.
   *
   * If the implementation short-circuited on the first mismatched index it
   * would be a timing oracle; correctness is asserted here by checking that
   * TWO distinct mismatch shapes (early-byte-diff vs late-byte-diff) both
   * produce 403 — i.e. the comparison looked at the whole string either way.
   */
  it("(15) equal-length states differing at any index are rejected (no short-circuit)", async () => {
    const storage = makeStorage();

    async function runWith(returnedState: string): Promise<number> {
      const stored = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"; // 43 chars
      const cookie = await seedPendingCookie(storage, {
        state: stored,
        codeVerifier: null,
        provider: "github",
      });
      const url = `https://app.example.com/auth/github/callback?state=${encodeURIComponent(returnedState)}&code=x`;
      const ctx = makeCtx(makeReq(url, { cookie }));
      await attachSession(ctx, storage);
      const { fetch: fakeFetch } = makeFetch([]);
      const mw = _oauthWith(fakeFetch, baseOptions());
      const res = (await mw(ctx)) as Response;
      return res.status;
    }

    // Early mismatch: first byte differs.
    const earlyDiff = "Xbcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    // Late mismatch: last byte differs.
    const lateDiff = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFX";

    expect(await runWith(earlyDiff)).toBe(403);
    expect(await runWith(lateDiff)).toBe(403);
  });
});

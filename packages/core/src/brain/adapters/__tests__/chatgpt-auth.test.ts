/**
 * Tests for the ChatGPT session-token auth helper
 * (`packages/core/src/brain/adapters/chatgpt-auth.ts`).
 *
 * ChatGPTAuth reads whatever `@openai/codex login` wrote to
 * `~/.codex/auth.json` (or the `CHATGPT_LOCAL_HOME` / `CODEX_HOME`
 * override), auto-refreshes when the access token is near expiry, and
 * exposes `{ accessToken, accountId, idToken, refreshToken }` to
 * callers. Tests here exercise the pure-file behaviour — the refresh
 * path uses an injected `httpClient` so no network hits the real
 * `auth.openai.com`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatGPTAuth } from "../chatgpt-auth";

let tmp: string;
let authPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-chatgpt-auth-"));
  authPath = path.join(tmp, "auth.json");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Minimal JWT whose `exp` claim is far in the future (no refresh). */
function makeFarFutureJwt(): string {
  const header = Buffer.from('{"alg":"none"}').toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // 24h from now
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

function makeExpiredJwt(): string {
  const header = Buffer.from('{"alg":"none"}').toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) - 60, // 1 min ago
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

function seedAuthFile(contents: unknown): void {
  writeFileSync(authPath, JSON.stringify(contents), { encoding: "utf-8" });
}

describe("ChatGPTAuth — discovery + isAuthenticated", () => {
  it("reports false when auth.json does not exist", () => {
    const auth = new ChatGPTAuth({ authFilePath: authPath });
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.locateAuthFile()).toBe(null);
  });

  it("reports true when auth.json has an access_token", () => {
    seedAuthFile({ tokens: { access_token: "x" } });
    const auth = new ChatGPTAuth({ authFilePath: authPath });
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.locateAuthFile()).toBe(authPath);
  });
});

describe("ChatGPTAuth — getAuth with a valid (non-expiring) token", () => {
  it("returns accessToken + accountId without calling refresh", async () => {
    const jwt = makeFarFutureJwt();
    seedAuthFile({
      tokens: {
        access_token: "live-access",
        id_token: jwt,
        refresh_token: "live-refresh",
      },
      last_refresh: new Date().toISOString(),
    });

    let refreshCalls = 0;
    const auth = new ChatGPTAuth({
      authFilePath: authPath,
      httpClient: async () => {
        refreshCalls++;
        return new Response("{}", { status: 200 });
      },
    });

    const effective = await auth.getAuth();
    expect(effective.accessToken).toBe("live-access");
    expect(effective.accountId).toBe("acct_test");
    expect(effective.sourcePath).toBe(authPath);
    expect(refreshCalls).toBe(0);
  });

  it("throws a helpful message when auth.json is missing", async () => {
    const auth = new ChatGPTAuth({ authFilePath: authPath });
    await expect(auth.getAuth()).rejects.toThrow(/auth\.json not found/);
  });
});

describe("ChatGPTAuth — automatic refresh on expired access_token", () => {
  it("calls the token endpoint once and persists the new tokens", async () => {
    const expiredJwt = makeExpiredJwt();
    seedAuthFile({
      tokens: {
        access_token: expiredJwt, // exp < now → triggers refresh
        id_token: expiredJwt,
        refresh_token: "r-fresh",
      },
    });

    let tokenCalls = 0;
    const newJwt = makeFarFutureJwt();
    const auth = new ChatGPTAuth({
      authFilePath: authPath,
      httpClient: async (url, init) => {
        tokenCalls++;
        expect(url).toBe("https://auth.openai.com/oauth/token");
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.grant_type).toBe("refresh_token");
        expect(body.refresh_token).toBe("r-fresh");
        return new Response(
          JSON.stringify({
            access_token: "brand-new-access",
            refresh_token: "brand-new-refresh",
            id_token: newJwt,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const effective = await auth.getAuth();
    expect(effective.accessToken).toBe("brand-new-access");
    expect(effective.refreshToken).toBe("brand-new-refresh");
    expect(effective.accountId).toBe("acct_test");
    expect(tokenCalls).toBe(1);

    // auth.json on disk should have been rewritten with the new tokens.
    const onDisk = JSON.parse(await fs.readFile(authPath, "utf-8"));
    expect(onDisk.tokens.access_token).toBe("brand-new-access");
    expect(onDisk.tokens.refresh_token).toBe("brand-new-refresh");
    expect(typeof onDisk.last_refresh).toBe("string");
  });

  it("surfaces token endpoint errors verbatim", async () => {
    seedAuthFile({
      tokens: {
        access_token: makeExpiredJwt(),
        refresh_token: "r-bad",
      },
    });

    const auth = new ChatGPTAuth({
      authFilePath: authPath,
      httpClient: async () =>
        new Response("bad token", { status: 401 }),
    });

    await expect(auth.getAuth()).rejects.toThrow(/Token refresh 401/);
  });
});

describe("ChatGPTAuth — malformed auth.json", () => {
  it("rejects when access_token is missing", async () => {
    seedAuthFile({ tokens: {} });
    const auth = new ChatGPTAuth({ authFilePath: authPath });
    await expect(auth.getAuth()).rejects.toThrow(/no access_token/);
  });

  it("rejects when refresh is required but refresh_token is absent", async () => {
    seedAuthFile({
      tokens: {
        access_token: makeExpiredJwt(),
        // refresh_token intentionally omitted
      },
    });
    const auth = new ChatGPTAuth({ authFilePath: authPath });
    await expect(auth.getAuth()).rejects.toThrow(/no refresh_token/);
  });
});

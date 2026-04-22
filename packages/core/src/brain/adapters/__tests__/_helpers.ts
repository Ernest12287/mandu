/**
 * Shared test fixtures for brain adapter tests.
 *
 * Every helper here stays framework-free so the unit tests do not pull
 * in the real network / keychain / filesystem paths.
 */

import path from "node:path";
import os from "node:os";
import {
  CredentialStore,
  type CredentialBackend,
  type StoredToken,
} from "../../credentials";
import type { HttpClient, OAuthEndpoints } from "../oauth-flow";
import { ChatGPTAuth } from "../chatgpt-auth";

/**
 * In-memory credential store that satisfies `CredentialBackend`. We
 * construct a regular `CredentialStore` around it so the adapters see
 * the exact public API (.load/.save/.delete/.list/.touch/.backendName).
 */
export function makeMemoryStore(
  seed: Record<string, StoredToken> = {},
): CredentialStore {
  const map = new Map<string, StoredToken>(Object.entries(seed));
  const backend: CredentialBackend = {
    name: "memory",
    async save(provider, token) {
      map.set(provider, token);
    },
    async load(provider) {
      return map.get(provider) ?? null;
    },
    async delete(provider) {
      map.delete(provider);
    },
    async list() {
      return [...map.keys()];
    },
  };
  return new CredentialStore(backend);
}

/**
 * Build a stub `HttpClient` whose behavior is driven by a response
 * factory. The factory receives the URL and RequestInit and returns a
 * `Response`. Tests use this to simulate 401 sequences, token
 * refresh, etc. without spinning up a live server.
 */
export function makeStubHttpClient(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): HttpClient {
  return async (url, init) => respond(url, init);
}

export const FAKE_ENDPOINTS: OAuthEndpoints = {
  authorizationUrl: "https://example.test/oauth/authorize",
  tokenUrl: "https://example.test/oauth/token",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Isolated ChatGPTAuth that always reports no session token — points at
 * a nonexistent path so it never picks up the developer's real
 * `~/.codex/auth.json`. Tests that exercise the keychain path must
 * pass this helper to prevent the ChatGPT code path from short-
 * circuiting the test's intended flow.
 */
export function makeEmptyChatGPTAuth(): ChatGPTAuth {
  return new ChatGPTAuth({
    authFilePath: path.join(
      os.tmpdir(),
      `mandu-test-no-auth-${process.pid}-${Date.now()}.json`,
    ),
  });
}

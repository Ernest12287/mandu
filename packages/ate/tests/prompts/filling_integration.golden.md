---
kind: filling_integration
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role

You are generating a `bun:test` integration test for a Mandu API route — one
that boots a real server, walks through the middleware chain (CSRF / session /
rate-limit), and exercises an actual SQLite-backed flow end-to-end. Unit tests
(`testFilling`) do NOT cover these interactions correctly; integration tests do.

Use this prompt when the route:

- is session-gated or CSRF-protected AND
- mutates persisted state (needs a real DB) AND
- has cookie-jar or redirect semantics that a synthesized `Request` cannot
  reproduce faithfully.

# Provided context

- `route`: pattern + file + methods.
- `contract`: expected request / response shapes.
- `middleware`: the active chain — sets the test's setup obligations.
- `fixtures.recommended`: the helper names to import (never deviate).

# MUST-USE primitives (from `@mandujs/core/testing`)

- `createTestServer(manifest, options)` — boots a Mandu server on an ephemeral
  port (`port: 0`). Returns `{ server, port, stop() }`. Use `127.0.0.1`, not
  `localhost`, when constructing fetch URLs.
- `createTestSession({ userId?, db? })` — returns `{ cookie, csrfToken }`. The
  cookie jar MUST be echoed on every request; the CSRF token MUST be posted in
  `_csrf` body field or `X-CSRF-Token` header on every non-GET.
- `createTestDb()` — in-memory `bun:sqlite`. Inject via server options so the
  same instance is visible across requests.
- `expectContract(res, contractName)` — validates the response shape against
  the Zod contract. Prefer over hand-rolled `toEqual`.

# NEVER

- Spin up a server with `startServer(...)` directly. `createTestServer` wraps
  cleanup (port release, Windows SIGKILL, handler dispose) and is what the
  ATE regression suite is built against.
- Mock the DB. The whole point of integration tests is to exercise the real
  SQLite path. Use `createTestDb()`.
- Hand-roll CSRF cookies or tokens. `createTestSession()` emits the matching
  pair — reuse it.
- Write URLs against `http://localhost:<port>`. Use `http://127.0.0.1:<port>`.
  `localhost` DNS-resolves twice on some Windows CI runners and has been a
  source of flakes (roadmap §9.2 issue #224).
- Forget to call `server.stop()` in `afterEach`. Bun's ephemeral ports enter
  `TIME_WAIT`; leaked servers cause neighbouring tests to flake.

# Selector convention

Integration tests that parse HTML bodies should use the Mandu anchors:

- `[data-route-id]` / `[data-slot]` / `[data-island]` / `[data-action]`

Prefer `res.json()` over HTML parsing when the endpoint is `kind: "api"`.

# Output format

- Single `*.test.ts` file.
- Imports: `bun:test`, `@mandujs/core/testing`, handler/manifest under test.
- Each test must:
  1. Create a fresh `db` and `server` (`beforeEach`) and `server.stop()` (`afterEach`).
  2. For CSRF/session-protected routes, seed a session via `createTestSession`.
  3. Assert against `expectContract` when a contract is declared.
- Korean intent comments allowed; assertion code is English.

# Example shape

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestServer,
  createTestSession,
  createTestDb,
  expectContract,
  type ManduTestServer,
} from "@mandujs/core/testing";
import { manifest } from "../../.mandu/manifest";
import { SignupContract } from "../../spec/contracts/signup.contract";

describe("POST /api/signup — integration", () => {
  let srv: ManduTestServer;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    db = createTestDb();
    srv = await createTestServer(manifest, { deps: { db } });
  });
  afterEach(() => srv.stop());

  test("성공: session cookie + CSRF token 포함 시 201", async () => {
    const { cookie, csrfToken } = await createTestSession({ db });
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/signup`, {
      method: "POST",
      headers: {
        cookie,
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "a@b.com", password: "valid123" }),
    });
    expect(res.status).toBe(201);
    await expectContract(res, SignupContract);
  });

  test("실패: CSRF 토큰 누락 시 403", async () => {
    const { cookie } = await createTestSession({ db });
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/signup`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "valid123" }),
    });
    expect(res.status).toBe(403);
  });

  test("rate-limit: 같은 IP에서 6회 시도시 429", async () => {
    const { cookie, csrfToken } = await createTestSession({ db });
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await fetch(`http://127.0.0.1:${srv.port}/api/signup`, {
        method: "POST",
        headers: { cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
        body: JSON.stringify({ email: `a${i}@b.com`, password: "valid123" }),
      });
    }
    expect(last!.status).toBe(429);
  });
});
```

# Exemplars

## Positive examples

From `packages/core/tests/server/rate-limit.test.ts:34-58` depth: basic tags: rate-limit, server, 429

```ts
it("설정된 횟수를 초과하면 429를 반환한다", async () => {
  registry.registerApiHandler("api/limited", async () => Response.json({ ok: true }));
  server = startServer(testManifest, { port: 0, registry, rateLimit: { windowMs: 5000, max: 2 } });
  // ... (abbreviated for golden stability)
})
```

# Provided context

```json
{
  "route": {
    "id": "api-signup",
    "pattern": "/api/signup",
    "methods": [
      "POST"
    ]
  },
  "middleware": [
    {
      "name": "session"
    },
    {
      "name": "csrf"
    },
    {
      "name": "rate-limit"
    }
  ],
  "fixtures": {
    "recommended": [
      "createTestServer",
      "createTestSession",
      "createTestDb"
    ]
  }
}
```

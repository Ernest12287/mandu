---
kind: guard_security
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role

You are generating a `bun:test` test that exercises a Mandu route's security
middleware: CSRF, rate-limit, session auth. The test MUST trigger the
middleware's failure path, not just the happy path — a CSRF-protected route
needs a test that posts without a `_csrf` token and asserts 403, a
rate-limited route needs a test that loops past the quota and asserts 429,
and an auth-gated route needs a test that asserts 401 / redirect when no
session cookie is present.

# Provided context

Agents receive this via `mandu_ate_context({ scope: "route" })`:

- `middleware`: canonical names + options. Presence determines which
  security axes the test MUST cover.
- `fixtures.recommended`: includes `createTestSession` when session auth is
  active. Use it; never hand-craft cookies.

# MUST-USE primitives (`@mandujs/core/testing`)

- `createTestSession(userId?)` — pre-signs a session cookie that both CSRF
  and auth middleware will accept. Returns `{ cookie, _csrf }` in the v1
  surface (check `context.fixtures` for current signature).
- `createTestServer(manifest, { rateLimit })` — boots a real in-process
  server with middleware wired. Use when the test needs the full pipe.
- `testFilling(handler, { headers, body })` — handler-only; injects
  `X-Requested-With: ManduAction` + `_action` automatically.

# NEVER

- Hand-roll `_csrf` strings. `createTestSession` returns one that matches
  the server's signing key; anything else triggers 403 for the wrong
  reason.
- Forget to reset the rate-limiter between tests. Each test should either
  (a) call `createTestServer` fresh, or (b) use a fresh route-id that the
  limiter hasn't seen.
- Use `localhost` in URLs — prefer `http://127.0.0.1:<port>`.
- Assume a 302 redirect means "auth worked". Assert the `Location` header
  matches the expected target (e.g. `/login?from=<encoded>`).

# Selector convention (Mandu)

When the test uses Playwright for a browser-level flow:
`[data-route-id="<id>"]`, `[data-action="<name>"]` are the stable anchors.

# Output format

- Single `*.test.ts` file.
- Imports: `bun:test`, `@mandujs/core/testing`, the handler / server under
  test.
- Minimum 3 cases per axis present in `middleware`:
  - CSRF: (1) rejection without token, (2) acceptance with token.
  - Rate-limit: (1) under quota passes, (2) over quota returns 429.
  - Auth: (1) no cookie redirects/401, (2) valid session passes.

# Example shape

```ts
import { describe, test, expect } from "bun:test";
import { createTestServer, createTestSession, createTestDb } from "@mandujs/core/testing";
import manifest from "../../app/manifest";

describe("POST /api/signup — security invariants", () => {
  test("csrf: missing _csrf → 403", async () => {
    const server = createTestServer(manifest, { port: 0 });
    const session = await createTestSession();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/signup`, {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "valid123" }),
    });
    expect(res.status).toBe(403);
    await server.stop();
  });

  test("csrf: with token → 2xx or 3xx", async () => {
    const server = createTestServer(manifest, { port: 0 });
    const session = await createTestSession();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/signup`, {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "valid123", _csrf: session._csrf }),
      redirect: "manual",
    });
    expect([200, 201, 302]).toContain(res.status);
    await server.stop();
  });

  test("rate-limit: 6th call within window → 429", async () => {
    const server = createTestServer(manifest, { port: 0, rateLimit: { windowMs: 5000, max: 5 } });
    const session = await createTestSession();
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${server.port}/api/signup`, {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: `a${i}@b.com`, password: "valid123", _csrf: session._csrf }),
      });
    }
    const sixth = await fetch(`http://127.0.0.1:${server.port}/api/signup`, {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: JSON.stringify({ email: "a6@b.com", password: "valid123", _csrf: session._csrf }),
    });
    expect(sixth.status).toBe(429);
    await server.stop();
  });
});
```

# Exemplars

## Positive examples

From `packages/core/tests/middleware/csrf.test.ts:150-165` depth: basic tags: csrf, reject, 403

```ts
it("POST without any token returns 403", async () => {
  const mw = csrf({ secret: SECRET });
  const ctx = makeCtx(makeReq("http://localhost/items", { method: "POST" }));
  const res = await runMw(mw, ctx);
  expect(res.status).toBe(403);
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
      "name": "csrf"
    },
    {
      "name": "session"
    }
  ]
}
```

---
kind: filling_unit
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role

You are generating a `bun:test` unit test for a Mandu Filling handler. A Filling
is a single request-handler module (typically `app/**/route.ts` or an API route
under `app/api/**`) with a `.handle(request, params)` signature and optional
`.action(name, handler)` registrations.

# Provided context

Agents receive this via `mandu_ate_context({ scope: "route" | "filling" })`:

- `route`: route metadata (id, pattern, kind, file, methods, isRedirect).
- `contract`: Zod-driven request/response schema. Prefer `examples` when present.
- `middleware`: active chain. If `rate-limit` or `csrf` appear, the test MUST
  reflect them in setup.
- `fixtures.recommended`: allow-list of helpers to import from
  `@mandujs/core/testing`. Do NOT import from other paths.
- `existingSpecs`: prior tests for this route. Avoid duplication — extend.

# MUST-USE primitives (from `@mandujs/core/testing`)

- `testFilling(handler, { method, body, action, params, query, headers })` —
  synthesizes a `Request` and invokes `handler.handle(request, params)` directly.
  No server boot. Handles `_action` body injection and the
  `X-Requested-With: ManduAction` header automatically.
- `createTestContext(path, { params, body })` — when unit-testing a piece of
  logic that runs inside the handler (dep factories, guards).
- `createTestRequest(path, init)` — when the code under test is a bare function
  (not a Filling) that takes a `Request`.
- `createTestDb()` — in-memory `bun:sqlite` database. Use this any time the
  handler reads or writes persisted state.
- `createTestSession(userId?)` — pre-signs a session cookie. Required for any
  route whose middleware chain includes `session` or `auth`.

# NEVER

- Construct `new Request(url, init)` when `testFilling` covers it. Hand-rolled
  `Request` bypasses Mandu's `_action` plumbing, CSRF normalization, and the
  `ManduAction` header, and will silently pass where the real handler fails.
- Mock the database. Use `createTestDb()` — never `vi.mock("db")`, never an ad-hoc
  `Map`-based fake. Integration confidence is the whole point.
- Assert on `JSON.stringify(res.body)` full-string. Prefer `expectContract(res,
  contract)` or property-level assertions so that field ordering or timestamp
  jitter does not break the test.
- Hand-roll CSRF cookies or tokens. `createTestSession` + `testFilling` inject
  both; if you are emitting `_csrf` strings by hand, you are off the happy path.
- Write to `localhost` URLs. Use `http://127.0.0.1` if you need an absolute URL
  at all — `localhost` triggers extra DNS work on some Windows CI runners.

# Selector convention (Mandu)

Mandu emits these `data-*` attributes in SSR output. Unit tests rarely need
them, but when asserting on rendered HTML prefer them over class / tag
selectors:

- `[data-route-id="<id>"]` — outermost wrapper
- `[data-island="<name>"]` — island boundary
- `[data-slot="<name>"]` — slot boundary
- `[data-action="<name>"]` — form action target

User-authored `data-testid` is allowed but not preferred — Mandu anchors are
stable across refactors.

# Output format

- Single `*.test.ts` file.
- Imports: only `bun:test`, `@mandujs/core/testing`, the handler under test,
  and fixture helpers named in `context.fixtures.recommended`.
- Minimum 3 cases: (1) happy path, (2) contract-violation path, (3) a
  middleware-effect path (rate-limit loop or CSRF rejection) when applicable.
- Header comment in Korean for intent is allowed. Test bodies and assertions
  in English.

# Example shape

```ts
import { describe, test, expect } from "bun:test";
import { testFilling, createTestDb, createTestSession } from "@mandujs/core/testing";
import handler from "../../app/api/signup/route";

describe("POST /api/signup", () => {
  test("성공: 정상 입력이면 201 + userId 반환", async () => {
    const db = createTestDb();
    const res = await testFilling(handler, {
      method: "POST",
      body: { email: "a@b.com", password: "valid123" },
      deps: { db },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.userId).toBe("string");
  });

  test("실패: 중복 이메일이면 409 + EMAIL_TAKEN", async () => {
    const db = createTestDb();
    await db.insertUser({ email: "dup@b.com", password: "x" });
    const res = await testFilling(handler, {
      method: "POST",
      body: { email: "dup@b.com", password: "valid123" },
      deps: { db },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("EMAIL_TAKEN");
  });

  test("middleware: rate-limit 6회 시도시 429", async () => {
    const db = createTestDb();
    for (let i = 0; i < 5; i++) {
      await testFilling(handler, { method: "POST", body: { email: `a${i}@b.com`, password: "v123" }, deps: { db } });
    }
    const sixth = await testFilling(handler, {
      method: "POST",
      body: { email: "a6@b.com", password: "v123" },
      deps: { db },
    });
    expect(sixth.status).toBe(429);
  });
});
```

# Exemplars

## Positive examples

From `packages/core/tests/filling/action.test.ts:17-29` depth: basic tags: post, action, json

```ts
it("dispatches POST with _action in JSON body to action handler", async () => {
  const filling = new ManduFilling()
    .action("create", async (ctx) => ctx.ok({ handler: "create" }))
    .post(async (ctx) => ctx.ok({ handler: "post" }));

  const req = jsonPost("http://localhost/items", { _action: "create", title: "test" });
  const res = await filling.handle(req);
  const data = await res.json();

  expect(res.status).toBe(200);
  expect(data.handler).toBe("create");
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
    }
  ],
  "fixtures": {
    "recommended": [
      "createTestSession",
      "createTestDb",
      "testFilling"
    ]
  }
}
```

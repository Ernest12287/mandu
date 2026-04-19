---
title: "Testing — Getting Started"
status: phase-12.1
audience: Mandu app authors
bun_version: "1.3.12"
related:
  - packages/core/src/testing/index.ts
  - packages/cli/src/commands/test.ts
  - docs/bun/phase-12-diagnostics/testing-ecosystem.md
---

# Testing with Mandu

Mandu ships its own batteries-included test runner. Zero external deps
(no Vitest, no Jest, no Playwright required for unit / integration) —
just `mandu test`.

---

## Quick start

```bash
# Run everything (unit + integration, sequential)
mandu test

# Only unit tests
mandu test unit

# Only integration tests
mandu test integration

# Narrow with --filter (forwarded to `bun test`)
mandu test unit --filter login

# Watch mode
mandu test unit --watch

# CI-friendly: bail on first failure + coverage
mandu test --bail --coverage
```

Output is `bun test` output verbatim — you get JUnit-style line summaries,
inline `expect()` counts, and per-file timings. The framework adds a
one-line header per target so parallel targets stay legible:

```
mandu test unit (7 files)
bun test v1.3.12
 ✓ auth login (2 ms)
 ✓ user profile (1 ms)
 ...
```

---

## Configuration (`mandu.config.ts`)

Every knob lives under a single `test` block. Defaults are chosen so
brand-new projects need zero config; override only the fields you need.

```ts
// mandu.config.ts
export default {
  test: {
    unit: {
      include: ["**/*.test.ts", "**/*.test.tsx"],      // default
      exclude: ["node_modules/**", ".mandu/**"],        // default
      timeout: 30_000,                                  // default
    },
    integration: {
      include: ["tests/integration/**/*.test.ts"],      // default
      dbUrl: "sqlite::memory:",                         // default
      sessionStore: "memory",                           // or "sqlite"
      timeout: 60_000,                                  // default
    },
    coverage: { lines: 80, branches: 70 },              // Phase 12.3
  },
};
```

Unknown keys are rejected at load time — the schema is `.strict()` and
will tell you which keys are valid when you typo (e.g. `uint` vs `unit`).

---

## Unit tests

Use `testFilling`, `createTestRequest`, and `createTestContext` to drive
fillings without booting a server.

```ts
// src/api/todos.test.ts
import { test, expect } from "bun:test";
import { testFilling } from "@mandujs/core/testing";
import todoRoute from "../app/api/todos/route";

test("GET /api/todos returns current user's todos", async () => {
  const res = await testFilling(todoRoute, {
    method: "GET",
    headers: { Cookie: "userId=u_42" },
  });
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.todos).toHaveLength(3);
});
```

No server. No bundle. Pure function call — fast enough to run thousands
per second.

---

## Integration tests

Use `createTestServer` + `createTestSession` + `createTestDb` to build
end-to-end scenarios that actually exercise the HTTP stack.

```ts
// tests/integration/dashboard.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  createTestServer,
  createTestSession,
  createTestDb,
  type TestServer,
  type TestDb,
} from "@mandujs/core/testing";
import { manifest, registerHandlers } from "../../src/runtime";

describe("dashboard", () => {
  let server: TestServer;
  let db: TestDb;

  // Boot fresh fixtures per test — they're fast enough (ms) that parallel
  // isolation beats once-per-suite sharing for maintainability.
  beforeEach(async () => {
    db = await createTestDb({
      schema: `
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
        CREATE TABLE posts (id TEXT PRIMARY KEY, owner TEXT, title TEXT);
      `,
      seed: async (d) => {
        await d`INSERT INTO users VALUES (${"u1"}, ${"alice@x.y"})`;
      },
    });
    server = await createTestServer(manifest, {
      registerHandlers: (reg) => registerHandlers(reg, { db: db.db }),
    });
  });
  afterEach(async () => {
    server.close();
    await db.close();
  });

  test("redirects to /login when unauthenticated", async () => {
    const res = await server.fetch("/dashboard", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("renders dashboard when authenticated", async () => {
    const authed = await createTestSession({ userId: "u1" });
    const res = await server.fetch("/dashboard", { headers: authed.headers });
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Welcome back, alice@x.y");
  });
});
```

### Why a session fixture, not a POST to `/login`?

Your login endpoint is behind CSRF, rate limit, maybe 2FA. Tests that
need "given a logged-in user, when..." should **not** re-validate the
login path — they should start from an authenticated state directly.
That's what `createTestSession()` gives you.

For tests of the login path itself, call the route directly with
`server.fetch("/login", ...)`.

---

## Mocks for external I/O

`mockMail()` and `mockStorage()` are drop-in replacements for the
`EmailSender` and `S3Client` interfaces. They capture calls for
assertion.

```ts
import { mockMail, mockStorage } from "@mandujs/core/testing";
import { sendVerificationEmail } from "../src/auth/verification";

test("sends a verification email on signup", async () => {
  const mail = mockMail();
  await sendVerificationEmail({ mail }, "new-user@x.y");

  const message = mail.lastTo("new-user@x.y");
  expect(message?.subject).toMatch(/verify/i);
});

test("stores uploaded avatar under u/<id>.png", async () => {
  const storage = mockStorage();
  const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  await uploadAvatar({ storage }, "u1", buffer);

  expect(await storage.exists("u/u1.png")).toBe(true);
  expect(storage.peek("u/u1.png")?.contentType).toBe("image/png");
});
```

Both mocks support `Symbol.dispose`, so Bun's Explicit Resource Management
(`using`) works:

```ts
test("idempotent", () => {
  using mail = mockMail();          // auto-clears on scope exit
  using storage = mockStorage();    // auto-clears on scope exit
  // ...
});
```

---

## API surface

| Fixture                        | Returns                    | Cleanup                       |
|--------------------------------|----------------------------|-------------------------------|
| `testFilling(filling, opts?)`  | `Promise<Response>`        | — (pure call)                 |
| `createTestRequest(path, opts?)` | `Request`                | — (plain object)              |
| `createTestContext(path, opts?)` | `ManduContext`           | — (plain object)              |
| `createTestServer(manifest, opts?)` | `Promise<TestServer>` | `.close()` / `asyncDispose`   |
| `createTestSession(opts)`      | `Promise<TestSession>`     | — (cookie only)               |
| `createTestDb(opts?)`          | `Promise<TestDb>`          | `.close()` / `asyncDispose`   |
| `mockMail()`                   | `MockMail`                 | `.clear()` / `dispose`        |
| `mockStorage(opts?)`           | `MockStorage`              | `.clear()` / `dispose`        |

Every async fixture implements `Symbol.asyncDispose` so you can use
`await using` in modern Bun:

```ts
test("all fixtures in one test", async () => {
  await using server = await createTestServer(manifest);
  await using db = await createTestDb({ schema: "..." });
  using mail = mockMail();
  // ...teardown runs automatically in reverse order
});
```

---

## CI hints

```yaml
# .github/workflows/test.yml
- run: bun install --frozen-lockfile
- run: mandu test --bail
```

Exit code `0` on success, `1` on any failure. `--bail` stops after the
first failure so CI logs stay focused on the root cause.

---

## What's next

- **Phase 12.2** — `mandu test e2e` (ATE integration, Playwright wrapper).
- **Phase 12.3** — snapshot, HMR-aware watch, coverage merge, DB
  fixture with full resource migrations.

See `docs/bun/phase-12-diagnostics/testing-ecosystem.md` for the roadmap.

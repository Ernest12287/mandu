---
name: mandu-phase-testing
version: 1.0.0
audience: AI Agents working on tests
last_verified: 2026-04-18
---

# Testing Strategy Prompt

Mandu ships a three-tier testing strategy powered by the
**ATE (Automation Test Engine)**. When adding or fixing tests,
pick the right tier first.

## Tier Selection

| Tier | Oracle | Tool | When to Use |
|---|---|---|---|
| Unit | L0 / L1 | `bun:test` + `testFilling` | Single route handler, pure functions, contract-shape checks |
| Integration | L2 | `bun:test` + real server (`port: 0`) | Routes that touch resources, cookies, auth middleware |
| E2E | L3 | Playwright | Page rendering, islands, user journeys |

Never write a full E2E when a unit test would catch the regression.

## Unit Test Template

```typescript
import { describe, it, expect } from "bun:test";
import { testFilling } from "@mandujs/core/testing";
import route from "@/app/api/users/route";

describe("/api/users", () => {
  it("GET returns 200 with user list", async () => {
    const res = await testFilling(route, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("users");
    expect(Array.isArray(body.users)).toBe(true);
  });

  it("POST with valid body creates a user", async () => {
    const res = await testFilling(route, {
      method: "POST",
      body: { name: "Alice" },
    });
    expect([200, 201]).toContain(res.status);
  });
});
```

<constraints>
  <rule>Always import `testFilling` from `@mandujs/core/testing` — never Node's `http`.</rule>
  <rule>Always `await testFilling(...)`.</rule>
  <rule>Never hit real external APIs in unit tests.</rule>
  <rule>Cookies: pass via `{ cookies: "sid=abc" }` option.</rule>
</constraints>

## Integration Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer, clearDefaultRegistry } from "@mandujs/core";
import manifest from "@/.mandu/manifest.json" with { type: "json" };

let server: ReturnType<typeof startServer>;
let baseUrl: string;

beforeAll(async () => {
  server = await startServer(manifest, { port: 0 });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  clearDefaultRegistry();
});

describe("Integration: /api/users", () => {
  it("round-trips a user", async () => {
    const post = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      body: JSON.stringify({ name: "Bob" }),
    });
    expect(post.status).toBe(201);

    const list = await fetch(`${baseUrl}/api/users`);
    const data = (await list.json()) as { users: { name: string }[] };
    expect(data.users.some((u) => u.name === "Bob")).toBe(true);
  });
});
```

<constraints>
  <rule>Always use ephemeral port (`port: 0`).</rule>
  <rule>Always stop the server and `clearDefaultRegistry()` in `afterAll`.</rule>
  <rule>Each test block should leave state clean for the next.</rule>
</constraints>

## E2E Test Template

```typescript
import { test, expect } from "@playwright/test";

test("users page renders and island hydrates", async ({ page }) => {
  await page.goto("/users");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: /users/i })).toBeVisible();
  await expect(page.getByRole("list")).toBeVisible();
});
```

<constraints>
  <rule>Prefer accessible locators: `getByRole`, `getByLabel`, `getByText`.</rule>
  <rule>`waitForLoadState("networkidle")` before interacting with islands.</rule>
  <rule>Put specs under `tests/e2e/manual/` for human-written, `tests/e2e/auto/` is ATE-managed.</rule>
</constraints>

## ATE Commands

- `mandu test-auto` — extract → generate → run full pipeline.
- `mandu test:auto --impact` — only run tests for changed routes.
- `mandu test-heal --run-id <id>` — suggest fixes for flaky selectors.
- `mandu test:watch` — rerun tests when source changes.

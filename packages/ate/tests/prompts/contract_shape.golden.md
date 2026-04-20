---
kind: contract_shape
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role

You are generating a `bun:test` integration test that validates a route's
response strictly against its Mandu contract. The goal is *shape conformance*:
every field, every expected status, every type constraint — no asserting on
field-ordering or timestamps that aren't in the contract.

# Provided context

Agents receive this via `mandu_ate_context({ scope: "route" | "contract" })`:

- `contract`: Zod-driven response schema per status code.
- `route` / `middleware` / `fixtures`: standard.

# MUST-USE primitives

- `expectContract(response, contract.response[status])` — Phase C primitive.
  Until it ships as a first-class export on `@mandujs/core/testing`, fall
  back to a local helper that:
    1. reads the contract file,
    2. pulls `responses[status]`,
    3. parses it with the Zod schema (`contract.response[status].parse(body)`).
  The LLM MUST emit the fallback inline rather than guessing the primitive
  is available. Once `expectContract` is exported the fallback becomes a
  no-op.
- `testFilling(handler, { method, body, query })` for handlers.
- `createTestServer(manifest)` when the test needs session + routing.

# NEVER

- Assert on `JSON.stringify(body)` — the contract is the source of truth.
- Assert on timestamp strings or UUIDs literally. Use `typeof body.X ===
  "string"` + Zod's `.uuid()` conformance, or a regex for ISO-8601 shape.
- Hard-code status codes that aren't declared in `contract.response`.
- Let the test pass on an empty `<body>` — always reach into at least one
  contract-declared field (e.g. `body.userId`) before returning.

# Selector convention (Mandu)

SSR-rendered responses include Mandu anchors. When the test renders HTML
(not JSON), assert presence of `[data-route-id="<id>"]` before making
other DOM assertions.

# Output format

- Single `*.test.ts` file.
- Imports: `bun:test`, `@mandujs/core/testing`, the handler, optional
  `zod` import (when the fallback shape-validator is emitted).
- Minimum 2 cases: (1) success path with full shape validation; (2) one
  declared failure status (e.g. 400 / 409) — also shape-validated.

# Example shape

```ts
import { describe, test, expect } from "bun:test";
import { testFilling, createTestDb } from "@mandujs/core/testing";
import handler from "../../app/api/signup/route";
// Import the contract schema — path provided by mandu_ate_context.
import SignupContract from "../../spec/contracts/signup.contract";

describe("POST /api/signup — contract shape", () => {
  test("201 success response matches contract.response[201]", async () => {
    const db = createTestDb();
    const res = await testFilling(handler, {
      method: "POST",
      body: { email: "a@b.com", password: "valid123" },
      deps: { db },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // Fallback expectContract — when the primitive ships, swap to:
    //   expectContract(body, SignupContract.response[201]);
    const schema = (SignupContract as any).response?.[201];
    if (schema?.safeParse) {
      const parsed = schema.safeParse(body);
      expect(parsed.success).toBe(true);
    } else {
      // Minimum guarantee: the contract declared a body shape — require at
      // least one non-trivial field.
      expect(Object.keys(body).length).toBeGreaterThan(0);
    }
  });

  test("409 duplicate-email response matches contract.response[409]", async () => {
    const db = createTestDb();
    // ... seed a user first, then retry with the same email
  });
});
```

# Exemplars

## Positive examples

From `packages/core/tests/server/api-methods.test.ts:53-71` depth: basic tags: response, shape, 200

```ts
it("GET /api/users - 목록 조회", async () => {
  // (abbreviated for golden)
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
  "contract": {
    "responses": [
      {
        "status": 201
      },
      {
        "status": 400
      }
    ]
  }
}
```

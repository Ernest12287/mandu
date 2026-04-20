---
kind: property_based
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role

You are generating a `bun:test` property-based test that exercises a Mandu
Filling handler against a deterministic boundary-probe set. The set is the
output of `mandu_ate_boundary_probe({ contractName, method })` and is
provided inline in the context. Use `fast-check` for randomization on top
of (not instead of) those probes — every probe MUST be exercised; fast-check
supplies the fuzz around them.

# Provided context

Agents receive this via `mandu_ate_boundary_probe` + `mandu_ate_context`:

- `contract`: Zod-driven request/response schema (informational).
- `boundary.probes`: array of `{ field, category, value, reason, expectedStatus }`.
  Every row MUST be hit at least once by the generated test.
- `route` / `middleware` / `fixtures`: same as other prompt kinds.

# MUST-USE primitives

- `testFilling(handler, { method, body })` — from `@mandujs/core/testing`.
- `fc.property(...)` from `fast-check` for the fuzz layer. Wrap probe values
  with `fc.constantFrom(...probes.map(p => p.value))` so the explicit
  boundary set always appears in the input distribution.
- `expect(res.status).toBe(probe.expectedStatus)` when expectedStatus is
  non-null. Fall back to the documented `{ 2xx | 4xx }` class when the
  contract did not pin a specific code.

# NEVER

- Skip any probe. Loop through `probes` explicitly — a property test that
  only feeds `fc.string()` loses the boundary guarantees this tool ships.
- Assert on full `JSON.stringify(body)`. Narrow assertions per-field; the
  property layer amplifies brittleness otherwise.
- Introduce randomness on `expectedStatus` — contracts are authoritative.
- Use `Math.random()`. fast-check owns all randomness; otherwise replays fail.

# Selector convention (Mandu)

This prompt kind targets HTTP handlers, but if the test also renders HTML
(e.g. a page form post), prefer Mandu's data-* anchors:

- `[data-route-id="<id>"]`, `[data-island="<name>"]`, `[data-slot="<name>"]`.

# Output format

- Single `*.test.ts` file.
- Imports: `bun:test`, `fast-check`, `@mandujs/core/testing`, the handler
  under test.
- Two-phase structure:
  1. A `for`-loop over every `probe` — hit it directly and assert.
  2. A `test("property: …", () => fc.assert(fc.property(...)))` block
     that folds the probe set into its arbitrary.

# Example shape

```ts
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { testFilling, createTestDb } from "@mandujs/core/testing";
import handler from "../../app/api/signup/route";

const probes = [
  // Injected from mandu_ate_boundary_probe — keep literally.
  { field: "email", category: "invalid_format", value: "not-an-email", expectedStatus: 400, reason: "email fail" },
  { field: "email", category: "valid", value: "a@b.com", expectedStatus: 201, reason: "email pass" },
];

describe("POST /api/signup — property-based", () => {
  for (const probe of probes) {
    test(`boundary: ${probe.category} on ${probe.field} (${probe.reason})`, async () => {
      const db = createTestDb();
      const res = await testFilling(handler, {
        method: "POST",
        body: { [probe.field]: probe.value, password: "valid123" },
        deps: { db },
      });
      if (probe.expectedStatus != null) {
        expect(res.status).toBe(probe.expectedStatus);
      } else {
        expect([200, 201, 400, 422]).toContain(res.status);
      }
    });
  }

  test("property: every probe.value round-trips to contract-declared status", () => {
    const byCategory = new Map<string, typeof probes>();
    for (const p of probes) {
      const arr = byCategory.get(p.category) ?? [];
      arr.push(p);
      byCategory.set(p.category, arr);
    }
    fc.assert(
      fc.property(fc.constantFrom(...probes), async (probe) => {
        const db = createTestDb();
        const res = await testFilling(handler, {
          method: "POST",
          body: { [probe.field]: probe.value, password: "valid123" },
          deps: { db },
        });
        if (probe.expectedStatus != null) return res.status === probe.expectedStatus;
        return res.status >= 200 && res.status < 500;
      }),
      { numRuns: 60 },
    );
  });
});
```

# Exemplars

## Positive examples

From `packages/ate/tests/exemplar-sources/property-based.examples.ts:10-40` depth: basic tags: signup, email, boundary

```ts
it("every probe round-trips to contract-declared status", () => {
  fc.assert(
    fc.property(fc.constantFrom(...probes), async (probe) => {
      const res = await testFilling(handler, { method: "POST", body: { email: probe.value } });
      return res.status === probe.expectedStatus;
    }),
  );
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
  "boundary": {
    "probes": [
      {
        "field": "email",
        "category": "valid",
        "value": "a@b.com",
        "expectedStatus": 201
      },
      {
        "field": "email",
        "category": "invalid_format",
        "value": "not-an-email",
        "expectedStatus": 400
      }
    ]
  }
}
```

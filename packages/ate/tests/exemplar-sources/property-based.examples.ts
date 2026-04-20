/**
 * Canonical property_based exemplars for the prompt catalog.
 *
 * These `.examples.ts` files are intentionally NOT `.test.ts` — they are
 * snippet sources tagged with `@ate-exemplar: kind=property_based` so the
 * prompt composer can reference them. The scanner recognizes `test()` /
 * `it()` / `describe()` calls regardless of file extension as long as the
 * extension is `.ts` or `.tsx`.
 *
 * All four samples demonstrate the boundary-probe loop pattern the
 * `property_based.v1.md` template teaches.
 */
import { describe, it, expect } from "bun:test";

// Fake imports — this file is a template source, not an executing test.
// The fc / testFilling / handler imports would resolve in a real spec.
declare const fc: {
  assert: (prop: unknown, opts?: { numRuns?: number }) => void;
  property: <T>(arb: unknown, pred: (value: T) => boolean | Promise<boolean>) => unknown;
  constantFrom: <T>(...values: T[]) => unknown;
};
declare function testFilling(
  handler: unknown,
  init: { method: string; body?: unknown; deps?: unknown },
): Promise<Response>;
declare const handler: unknown;
declare const createTestDb: () => unknown;

describe("POST /api/signup — property_based exemplar (email boundary)", () => {
  const probes = [
    { field: "email", category: "valid", value: "a@b.com", expectedStatus: 201 },
    { field: "email", category: "invalid_format", value: "not-an-email", expectedStatus: 400 },
    { field: "email", category: "empty", value: "", expectedStatus: 400 },
  ];

  // @ate-exemplar: kind=property_based depth=basic tags=signup,email,boundary,status
  it("every probe round-trips to contract-declared status", () => {
    fc.assert(
      fc.property(fc.constantFrom(...probes), async (probe: (typeof probes)[number]) => {
        const db = createTestDb();
        const res = await testFilling(handler, {
          method: "POST",
          body: { email: probe.value, password: "valid123" },
          deps: { db },
        });
        return res.status === probe.expectedStatus;
      }),
      { numRuns: probes.length * 20 },
    );
    expect(probes.length).toBeGreaterThan(0);
  });
});

describe("POST /api/todos — property_based exemplar (title length)", () => {
  const probes = [
    { field: "title", category: "boundary_min", value: "", expectedStatus: 400 },
    { field: "title", category: "valid", value: "a", expectedStatus: 201 },
    { field: "title", category: "boundary_max", value: "a".repeat(200), expectedStatus: 201 },
    { field: "title", category: "boundary_max", value: "a".repeat(201), expectedStatus: 400 },
  ];

  // @ate-exemplar: kind=property_based depth=intermediate tags=todos,title,length,boundary
  it("title length boundaries round-trip", async () => {
    for (const probe of probes) {
      const res = await testFilling(handler, {
        method: "POST",
        body: { title: probe.value, priority: "medium" },
      });
      expect(res.status).toBe(probe.expectedStatus);
    }
  });
});

describe("PATCH /api/notes/:id — property_based exemplar (enum)", () => {
  const probes = [
    { field: "priority", category: "valid", value: "high", expectedStatus: 200 },
    { field: "priority", category: "valid", value: "medium", expectedStatus: 200 },
    { field: "priority", category: "valid", value: "low", expectedStatus: 200 },
    { field: "priority", category: "enum_reject", value: "urgent", expectedStatus: 400 },
  ];

  // @ate-exemplar: kind=property_based depth=basic tags=notes,enum,boundary
  it("enum variants round-trip per contract", async () => {
    for (const probe of probes) {
      const res = await testFilling(handler, {
        method: "PATCH",
        body: { priority: probe.value },
      });
      expect(res.status).toBe(probe.expectedStatus);
    }
  });
});

describe("POST /api/search — property_based exemplar (union)", () => {
  const probes = [
    { field: "q", category: "valid", value: "hello", expectedStatus: 200 },
    { field: "q", category: "valid", value: 42, expectedStatus: 200 },
    { field: "q", category: "type_mismatch", value: true, expectedStatus: 400 },
  ];

  // @ate-exemplar: kind=property_based depth=advanced tags=search,union,type-mismatch
  it("union(string|number) accepts both primitives but rejects boolean", () => {
    fc.assert(
      fc.property(fc.constantFrom(...probes), async (probe: (typeof probes)[number]) => {
        const res = await testFilling(handler, {
          method: "POST",
          body: { q: probe.value },
        });
        return res.status === probe.expectedStatus;
      }),
      { numRuns: 30 },
    );
    expect(probes.length).toBe(3);
  });
});

/**
 * Phase B.1 — boundary integration tests: real contract files round-trip.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateProbes, deriveExpectedStatus } from "../src/boundary";

describe("boundary integration — real contract round-trip", () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-boundary-int-"));
    mkdirSync(join(repoRoot, "spec", "contracts"), { recursive: true });

    writeFileSync(
      join(repoRoot, "spec", "contracts", "signup.contract.ts"),
      `
import { z } from "zod";
import { Mandu } from "@mandujs/core";

export default Mandu.contract({
  request: {
    POST: {
      body: z.object({
        email: z.string().email(),
        password: z.string().min(8).max(72),
        role: z.enum(["user", "admin"]).optional(),
      }),
    },
  },
  response: {
    201: z.object({ userId: z.string() }),
    400: z.object({ error: z.string() }),
    409: z.object({ error: z.string() }),
  },
});
`,
    );

    writeFileSync(
      join(repoRoot, "spec", "contracts", "age.contract.ts"),
      `
import { z } from "zod";
export default {
  request: {
    POST: { body: z.object({ age: z.number().int().min(0).max(120) }) },
  },
  response: {
    200: z.object({ ok: z.boolean() }),
    422: z.object({ errors: z.array(z.string()) }),
  },
};
`,
    );

    writeFileSync(
      join(repoRoot, "spec", "contracts", "no-response.contract.ts"),
      `
import { z } from "zod";
export default {
  request: { POST: { body: z.object({ x: z.string() }) } },
};
`,
    );
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("signup contract → at least 10 probes covering email + password + role", async () => {
    const res = await generateProbes({
      repoRoot,
      contractFile: join(repoRoot, "spec", "contracts", "signup.contract.ts"),
      method: "POST",
    });
    expect(res.probes.length).toBeGreaterThanOrEqual(10);
    const fields = new Set(res.probes.map((p) => p.field));
    expect(fields.has("email")).toBe(true);
    expect(fields.has("password")).toBe(true);
    expect(fields.has("role")).toBe(true);
  });

  test("signup: expectedStatus derived from response map", async () => {
    const res = await generateProbes({
      repoRoot,
      contractFile: join(repoRoot, "spec", "contracts", "signup.contract.ts"),
      method: "POST",
    });
    // Valid probes → 201 (first 2xx declared).
    const valid = res.probes.find((p) => p.category === "valid");
    expect(valid?.expectedStatus).toBe(201);
    // Invalid-format probe → 400.
    const invalidFormat = res.probes.find((p) => p.category === "invalid_format");
    expect(invalidFormat?.expectedStatus).toBe(400);
  });

  test("signup: every probe carries a method + graphVersion", async () => {
    const res = await generateProbes({
      repoRoot,
      contractFile: join(repoRoot, "spec", "contracts", "signup.contract.ts"),
      method: "POST",
    });
    expect(res.graphVersion).toMatch(/^gv1:/);
    for (const p of res.probes) {
      expect(p.method).toBe("POST");
    }
  });

  test("age contract: integer int() + min/max boundary yields 400/422 class", async () => {
    const res = await generateProbes({
      repoRoot,
      contractFile: join(repoRoot, "spec", "contracts", "age.contract.ts"),
      method: "POST",
    });
    const invalid = res.probes.find(
      (p) => p.category === "boundary_min" && p.value === -1,
    );
    // When 422 is declared, the invalid category prefers 422 over 400.
    expect(invalid?.expectedStatus).toBe(422);
  });

  test("no-response contract → probes with expectedStatus null", async () => {
    const res = await generateProbes({
      repoRoot,
      contractFile: join(repoRoot, "spec", "contracts", "no-response.contract.ts"),
      method: "POST",
    });
    expect(res.probes.length).toBeGreaterThan(0);
    for (const p of res.probes) expect(p.expectedStatus).toBeNull();
  });

  test("deriveExpectedStatus — explicit mapping", () => {
    const s = new Set([200, 400]);
    expect(deriveExpectedStatus("valid", s)).toBe(200);
    expect(deriveExpectedStatus("invalid_format", s)).toBe(400);
    expect(deriveExpectedStatus("valid", new Set<number>())).toBeNull();
  });

  test("probe dedup — email probes don't duplicate across methods", async () => {
    const res = await generateProbes({
      repoRoot,
      contractFile: join(repoRoot, "spec", "contracts", "signup.contract.ts"),
    });
    // Collapse to keys.
    const keys = new Set(res.probes.map((p) => `${p.field}|${p.category}|${JSON.stringify(p.value)}`));
    expect(keys.size).toBe(res.probes.length);
  });
});

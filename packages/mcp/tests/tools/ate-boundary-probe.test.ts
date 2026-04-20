/**
 * `mandu_ate_boundary_probe` MCP tool — round-trip tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ateBoundaryProbeToolDefinitions,
  ateBoundaryProbeTools,
} from "../../src/tools/ate-boundary-probe";

describe("mandu_ate_boundary_probe MCP tool", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-boundary-probe-"));
    mkdirSync(join(root, "spec", "contracts"), { recursive: true });
    writeFileSync(
      join(root, "spec", "contracts", "signup.contract.ts"),
      `import { z } from "zod";
export default {
  request: { POST: { body: z.object({
    email: z.string().email(),
    password: z.string().min(8),
  }) } },
  response: { 201: z.object({}), 400: z.object({ error: z.string() }) },
};
`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("tool def uses snake_case and requires repoRoot", () => {
    expect(ateBoundaryProbeToolDefinitions).toHaveLength(1);
    const d = ateBoundaryProbeToolDefinitions[0];
    expect(d.name).toBe("mandu_ate_boundary_probe");
    expect(d.name).toMatch(/^mandu_ate_[a-z_]+$/);
    expect(d.inputSchema.required).toContain("repoRoot");
  });

  test("returns probes + graphVersion for signup contract (via contractFile)", async () => {
    const h = ateBoundaryProbeTools(root);
    const res = (await h.mandu_ate_boundary_probe({
      repoRoot: root,
      contractFile: join(root, "spec", "contracts", "signup.contract.ts"),
      method: "POST",
    })) as {
      ok: boolean;
      probes: Array<{ field: string; category: string; expectedStatus: number | null }>;
      graphVersion: string;
    };
    expect(res.ok).toBe(true);
    expect(res.probes.length).toBeGreaterThanOrEqual(10);
    expect(res.graphVersion).toMatch(/^gv1:/);
    expect(res.probes.some((p) => p.field === "email")).toBe(true);
  });

  test("rejects missing repoRoot", async () => {
    const h = ateBoundaryProbeTools(root);
    const res = (await h.mandu_ate_boundary_probe({})) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/repoRoot/i);
  });
});

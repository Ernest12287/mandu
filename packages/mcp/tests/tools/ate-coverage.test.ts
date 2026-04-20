/**
 * `mandu_ate_coverage` MCP tool — round-trip tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ateCoverageToolDefinitions,
  ateCoverageTools,
} from "../../src/tools/ate-coverage";

describe("mandu_ate_coverage MCP tool", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-ate-coverage-"));
    mkdirSync(join(root, ".mandu"), { recursive: true });
    writeFileSync(
      join(root, ".mandu", "interaction-graph.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: "2026-04-20T00:00:00Z",
          buildSalt: "x",
          nodes: [
            {
              kind: "route",
              id: "/api/signup",
              file: "app/api/signup/route.ts",
              path: "/api/signup",
              routeId: "api-signup",
              hasContract: true,
              methods: ["POST"],
            },
          ],
          edges: [],
          stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("tool def uses snake_case and requires repoRoot", () => {
    expect(ateCoverageToolDefinitions[0].name).toBe("mandu_ate_coverage");
    expect(ateCoverageToolDefinitions[0].inputSchema.required).toContain("repoRoot");
  });

  test("returns metrics with graphVersion + topGaps", async () => {
    const h = ateCoverageTools(root);
    const res = (await h.mandu_ate_coverage({ repoRoot: root })) as {
      ok: boolean;
      routes: { total: number };
      invariants: Record<string, string>;
      topGaps: Array<{ kind: string; severity: string }>;
      graphVersion: string;
    };
    expect(res.ok).toBe(true);
    expect(res.routes.total).toBe(1);
    expect(res.graphVersion).toMatch(/^gv1:/);
    expect(Array.isArray(res.topGaps)).toBe(true);
  });

  test("rejects missing repoRoot", async () => {
    const h = ateCoverageTools(root);
    const res = (await h.mandu_ate_coverage({})) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
  });
});

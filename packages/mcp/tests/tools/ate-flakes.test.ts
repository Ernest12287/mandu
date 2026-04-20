/**
 * `mandu_ate_flakes` MCP tool tests.
 *
 * Covers:
 *   1. empty history → { ok: true, flakyTests: [] }
 *   2. flaky spec surfaces at flakeScore = 1.0
 *   3. minScore filter drops stable specs
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ateFlakesTools, ateFlakesToolDefinitions } from "../../src/tools/ate-flakes";
import { appendRunHistory } from "@mandujs/ate";

function seed(repoRoot: string, specPath: string, pattern: ("P" | "F")[]) {
  pattern.forEach((ch, i) =>
    appendRunHistory(repoRoot, {
      specPath,
      runId: `r-${specPath}-${i}`,
      status: ch === "P" ? "pass" : "fail",
      durationMs: 10,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      graphVersion: "gv1:test",
    }),
  );
}

describe("mandu_ate_flakes MCP tool", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-flakes-mcp-"));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  test("tool definition shape + snake_case naming", () => {
    expect(ateFlakesToolDefinitions).toHaveLength(1);
    const def = ateFlakesToolDefinitions[0];
    expect(def.name).toBe("mandu_ate_flakes");
    expect(def.name).toMatch(/^mandu_ate_[a-z_]+$/);
    const schema = def.inputSchema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(["repoRoot"]));
    expect(schema.properties).toHaveProperty("windowSize");
    expect(schema.properties).toHaveProperty("minScore");
  });

  test("empty history returns an empty flakyTests list", async () => {
    const handlers = ateFlakesTools(repoRoot);
    const result = await handlers.mandu_ate_flakes({ repoRoot });
    expect(result).toMatchObject({ ok: true, flakyTests: [] });
  });

  test("flaky spec surfaces at flakeScore = 1.0; stable specs are filtered by minScore", async () => {
    seed(repoRoot, "tests/e2e/flaky.spec.ts", ["P", "F", "P", "F", "P", "F"]);
    seed(repoRoot, "tests/e2e/stable.spec.ts", ["P", "P", "P", "P"]);

    const handlers = ateFlakesTools(repoRoot);
    const unfiltered = await handlers.mandu_ate_flakes({ repoRoot, minScore: 0.1 });
    expect((unfiltered as { ok: true; flakyTests: unknown[] }).ok).toBe(true);
    const flaky = (unfiltered as { flakyTests: Array<{ specPath: string; flakeScore: number }> }).flakyTests;
    expect(flaky).toHaveLength(1);
    expect(flaky[0].specPath).toBe("tests/e2e/flaky.spec.ts");
    expect(flaky[0].flakeScore).toBe(1);

    // minScore=0.99 still surfaces PFPFPF (=1.0) but nothing else.
    const stricter = await handlers.mandu_ate_flakes({ repoRoot, minScore: 0.99 });
    const stricterFlaky = (stricter as { flakyTests: unknown[] }).flakyTests;
    expect(stricterFlaky.length).toBe(1);

    // Invalid minScore is rejected by validation.
    const bad = await handlers.mandu_ate_flakes({ repoRoot, minScore: 2 });
    expect((bad as { ok: boolean }).ok).toBe(false);
  });
});

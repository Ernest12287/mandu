/**
 * `mandu_ate_exemplar` MCP tool — tests.
 *
 * Uses a tmpdir project with a couple of tagged tests so the test doesn't
 * race against the real repo's exemplar count (which will grow).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ateExemplarToolDefinitions,
  ateExemplarTools,
} from "../../src/tools/ate-exemplar";

describe("mandu_ate_exemplar MCP tool", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-ate-exemplar-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(
      join(root, "tests", "a.test.ts"),
      `import { test } from "bun:test";
// @ate-exemplar: kind=filling_unit tags=a
test("a1", () => { expect(1).toBe(1); });
// @ate-exemplar: kind=filling_unit tags=a,b
test("a2", () => { expect(1).toBe(1); });
// @ate-exemplar-anti: kind=filling_unit reason="wrong"
test("a3", () => { expect(1).toBe(1); });
`
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("definition is snake_case + requires repoRoot + kind", () => {
    expect(ateExemplarToolDefinitions).toHaveLength(1);
    const def = ateExemplarToolDefinitions[0];
    expect(def.name).toBe("mandu_ate_exemplar");
    expect(def.name).toMatch(/^mandu_ate_[a-z_]+$/);
    expect(def.inputSchema.required).toEqual(expect.arrayContaining(["repoRoot", "kind"]));
  });

  test("returns positive exemplars by default (no anti)", async () => {
    const h = ateExemplarTools(root);
    const res = (await h.mandu_ate_exemplar({
      repoRoot: root,
      kind: "filling_unit",
    })) as { ok: boolean; exemplars: Array<{ anti?: boolean }>; total: number };
    expect(res.ok).toBe(true);
    // Should return 2 positives, anti excluded.
    expect(res.exemplars.length).toBe(2);
    expect(res.exemplars.every((e) => !e.anti)).toBe(true);
    expect(res.total).toBe(3); // all three markers for this kind
  });

  test("includeAnti:true surfaces anti-exemplars", async () => {
    const h = ateExemplarTools(root);
    const res = (await h.mandu_ate_exemplar({
      repoRoot: root,
      kind: "filling_unit",
      includeAnti: true,
    })) as { ok: boolean; exemplars: Array<{ anti?: boolean }> };
    expect(res.ok).toBe(true);
    expect(res.exemplars.some((e) => e.anti === true)).toBe(true);
  });
});

/**
 * `mandu_ate_prompt` MCP tool — round-trip tests.
 *
 * The tool registration surface is tested against the real catalog at
 * `packages/ate/prompts/`. All tests use the current repo's cwd only for
 * exemplar scanning (the prompt template itself is always on disk).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atePromptToolDefinitions,
  atePromptTools,
} from "../../src/tools/ate-prompt";

describe("mandu_ate_prompt MCP tool", () => {
  // Use a tiny tmpdir as repoRoot instead of cwd — scanning the real Mandu
  // repo takes 100+ seconds because it parses every .ts/.tsx with ts-morph.
  let miniRepo: string;

  beforeAll(() => {
    miniRepo = mkdtempSync(join(tmpdir(), "mcp-ate-prompt-"));
    mkdirSync(join(miniRepo, "tests"), { recursive: true });
    writeFileSync(
      join(miniRepo, "tests", "demo.test.ts"),
      `import { test } from "bun:test";
// @ate-exemplar: kind=filling_unit tags=demo
test("demo", () => { expect(1).toBe(1); });
`
    );
  });

  afterAll(() => {
    rmSync(miniRepo, { recursive: true, force: true });
  });

  test("tool definition uses snake_case and requires 'kind'", () => {
    expect(atePromptToolDefinitions).toHaveLength(1);
    const def = atePromptToolDefinitions[0];
    expect(def.name).toBe("mandu_ate_prompt");
    expect(def.name).toMatch(/^mandu_ate_[a-z_]+$/);
    expect(def.inputSchema.required).toContain("kind");
    expect((def.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("context");
  });

  test("returns raw template + sha256 when context is omitted", async () => {
    const h = atePromptTools(miniRepo);
    const res = (await h.mandu_ate_prompt({ kind: "filling_unit" })) as {
      ok: boolean;
      prompt: string;
      sha256: string;
      version: number;
      kind: string;
      tokenEstimate: number;
    };
    expect(res.ok).toBe(true);
    expect(res.kind).toBe("filling_unit");
    expect(res.version).toBeGreaterThanOrEqual(1);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Template body markers.
    expect(res.prompt).toContain("kind: filling_unit");
    expect(res.prompt).toContain("# Role");
    expect(res.prompt).toContain("testFilling");
    expect(res.prompt).toContain("<!-- EXEMPLAR_SLOT -->");
    expect(res.tokenEstimate).toBeGreaterThan(0);
  });

  test("returns composed prompt (slot replaced) when context is present", async () => {
    const h = atePromptTools(miniRepo);
    const res = (await h.mandu_ate_prompt({
      kind: "filling_unit",
      context: { route: "/api/signup", methods: ["POST"] },
      repoRoot: miniRepo,
    })) as { ok: boolean; prompt: string; exemplarCount: number; antiCount: number };
    expect(res.ok).toBe(true);
    // The slot must have been replaced (or the fallback "no exemplars" block inserted).
    expect(res.prompt).not.toContain("<!-- EXEMPLAR_SLOT -->");
    // Context was serialized into the prompt.
    expect(res.prompt).toContain("/api/signup");
    // exemplarCount is non-negative.
    expect(res.exemplarCount).toBeGreaterThanOrEqual(0);
  });

  test("unknown kind returns ok:false with a parseable error", async () => {
    const h = atePromptTools(miniRepo);
    const res = (await h.mandu_ate_prompt({ kind: "does_not_exist" })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
  });
});

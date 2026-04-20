/**
 * `mandu_ate_save` MCP tool — lint-before-write tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ateSaveToolDefinitions,
  ateSaveTools,
  lintContent,
} from "../../src/tools/ate-save";

describe("mandu_ate_save MCP tool", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-ate-save-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("definition is snake_case + requires path + content", () => {
    expect(ateSaveToolDefinitions).toHaveLength(1);
    const def = ateSaveToolDefinitions[0];
    expect(def.name).toBe("mandu_ate_save");
    expect(def.name).toMatch(/^mandu_ate_[a-z_]+$/);
    expect(def.inputSchema.required).toEqual(expect.arrayContaining(["path", "content"]));
  });

  test("valid content writes successfully with no blocking diagnostics", async () => {
    const h = ateSaveTools(root);
    const target = join(root, "tests", "valid.test.ts");
    const res = (await h.mandu_ate_save({
      path: target,
      content: `import { test, expect } from "bun:test";
import { testFilling, createTestDb } from "@mandujs/core/testing";

test("example", async () => {
  const db = createTestDb();
  const res = await testFilling({} as any, { method: "GET" });
  expect(res.status).toBe(200);
});
`,
    })) as { saved: boolean; path: string; lintDiagnostics: unknown[] };
    expect(res.saved).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("example");
    // No blocking diagnostics (warnings about unused imports are OK).
  });

  test("syntax errors block the write", async () => {
    const h = ateSaveTools(root);
    const target = join(root, "tests", "syntax-err.test.ts");
    const res = (await h.mandu_ate_save({
      path: target,
      content: `import { test } from "bun:test";
test("broken", () => {
  // missing close brace
`,
    })) as { saved: boolean; blockingErrors?: Array<{ code: string }> };
    expect(res.saved).toBe(false);
    expect(res.blockingErrors?.some((e) => e.code === "syntax_error")).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  test("banned import paths block the write", async () => {
    const h = ateSaveTools(root);
    const target = join(root, "tests", "bad-import.test.ts");
    const res = (await h.mandu_ate_save({
      path: target,
      content: `import { test } from "bun:test";
import { testFilling } from "@mandu/core/testing"; // typo: @mandu vs @mandujs

test("a", () => { testFilling; expect(1).toBe(1); });
`,
    })) as { saved: boolean; blockingErrors?: Array<{ code: string; message: string }> };
    expect(res.saved).toBe(false);
    expect(res.blockingErrors?.some((e) => e.code === "banned_import")).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  test("bare localhost + hand-rolled CSRF + db mock all block the write", async () => {
    const h = ateSaveTools(root);
    const target = join(root, "tests", "anti-patterns.test.ts");
    const res = (await h.mandu_ate_save({
      path: target,
      content: `import { test, expect } from "bun:test";

vi.mock("./db", () => ({}));

test("bad", async () => {
  const res = await fetch("http://localhost:3333/api/login", {
    headers: { cookie: "__csrf=manual" },
  });
  expect(res.status).toBe(200);
});
`,
    })) as { saved: boolean; blockingErrors?: Array<{ code: string }> };
    expect(res.saved).toBe(false);
    const codes = res.blockingErrors?.map((e) => e.code) ?? [];
    expect(codes).toContain("bare_localhost");
    expect(codes).toContain("hand_rolled_csrf");
    expect(codes).toContain("db_mock");
    expect(existsSync(target)).toBe(false);
  });

  test("lintContent can be called directly and flags unused imports as warning (not blocking)", async () => {
    const diag = await lintContent(
      "/tmp/some.test.ts",
      `import { test, expect } from "bun:test";
import { createTestDb } from "@mandujs/core/testing";

test("x", () => {
  expect(1).toBe(1);
});
`
    );
    const unused = diag.find((d) => d.code === "unused_import");
    expect(unused).toBeDefined();
    expect(unused!.blocking).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Phase 9a — init landing markdown template smoke tests.
 *
 * We assert the shared template file exists, contains the expected
 * placeholder tokens, and that placeholder substitution matches what
 * `renderInitLanding` performs internally.
 */
describe("init landing markdown template", () => {
  const templatePath = path.resolve(
    import.meta.dir,
    "..",
    "..",
    "templates",
    "init-landing.md"
  );

  it("exists on disk", () => {
    expect(existsSync(templatePath)).toBe(true);
  });

  it("contains the expected placeholder tokens", () => {
    const raw = readFileSync(templatePath, "utf-8");
    for (const token of [
      "{{projectName}}",
      "{{targetDir}}",
      "{{installHint}}",
      "{{cssLine}}",
      "{{uiLines}}",
      "{{mcpLines}}",
      "{{skillsLines}}",
      "{{lockfileLines}}",
    ]) {
      expect(raw).toContain(token);
    }
  });

  it("produces a complete landing after placeholder substitution", () => {
    const raw = readFileSync(templatePath, "utf-8");
    const filled = raw
      .replace(/\{\{projectName\}\}/g, "my-app")
      .replace(/\{\{targetDir\}\}/g, "/tmp/my-app")
      .replace(/\{\{installHint\}\}/g, "")
      .replace(/\{\{cssLine\}\}/g, "\n- `app/globals.css` — Global CSS")
      .replace(/\{\{uiLines\}\}/g, "")
      .replace(/\{\{mcpLines\}\}/g, "- `.mcp.json` created")
      .replace(/\{\{skillsLines\}\}/g, "- 3/5 skills installed")
      .replace(/\{\{lockfileLines\}\}/g, "- Lockfile generation skipped");

    expect(filled).not.toContain("{{");
    expect(filled).toContain("my-app");
    expect(filled).toContain("/tmp/my-app");
    expect(filled).toContain("bun run dev");
    expect(filled).toContain("AI agent integration");
  });
});

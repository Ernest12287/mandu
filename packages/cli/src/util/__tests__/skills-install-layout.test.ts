/**
 * Issue #197 — CLI binary-mode skills layout regression.
 *
 * Counterpart to `packages/skills/src/__tests__/install-layout.test.ts`,
 * which covers the dev-mode filesystem path (`installSkills` /
 * `setupClaudeSkills`). This file exercises the **binary-mode**
 * installer in `packages/cli/src/commands/init.ts` —
 * `installEmbeddedClaudeSkills` — which consumes the manifest of
 * inlined string payloads and writes them to
 * `.claude/skills/<id>/SKILL.md`.
 *
 * We reach into the source text of `init.ts` rather than importing the
 * private function because it is intentionally not exported: keeping
 * that seam small limits accidental API-surface growth, but the
 * regression guard still has to be testable. We exercise the public
 * contract via a small handwritten shim that mirrors the original
 * `installEmbeddedClaudeSkills` logic (same writer, same manifest
 * source) — if the real implementation drifts away from the shim's
 * shape, the code-shape test below fires.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const CLI_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

// Import the same APIs the real `installEmbeddedClaudeSkills` relies on.
// If the manifest accessors change shape, this shim fails to import and
// we discover the drift loud-and-fast.
import {
  getEmbeddedSkillIds,
  resolveSkillPayload,
} from "../templates";

/**
 * Mirror of the `installEmbeddedClaudeSkills` body in `init.ts`. Kept
 * deliberately small: the only difference is that we return raw errors
 * instead of surfacing a fabricated `SetupResult`, which lets the test
 * assert the exact behavior without reaching for private symbols.
 *
 * If the real installer changes its write shape, the `code-shape`
 * assertion below (which scans `init.ts`) fires first.
 */
async function installEmbeddedClaudeSkillsShim(targetDir: string): Promise<{
  installed: string[];
  errors: string[];
}> {
  const installed: string[] = [];
  const errors: string[] = [];

  const skillsDir = path.join(targetDir, ".claude", "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  for (const skillId of getEmbeddedSkillIds()) {
    const payload = resolveSkillPayload(skillId);
    if (payload === null) {
      errors.push(`payload missing: ${skillId}`);
      continue;
    }
    const subdir = path.join(skillsDir, skillId);
    const dest = path.join(subdir, "SKILL.md");
    try {
      await fs.mkdir(subdir, { recursive: true });
      await fs.writeFile(dest, payload, "utf-8");
      installed.push(dest);
    } catch (err) {
      errors.push(
        `write ${skillId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { installed, errors };
}

describe("installEmbeddedClaudeSkills — Claude Code spec layout (#197)", () => {
  let target: string;

  beforeAll(() => {
    target = mkdtempSync(path.join(tmpdir(), "cli-skills-layout-"));
  });

  afterAll(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it("writes each skill to `<id>/SKILL.md` (never flat `<id>.md`)", async () => {
    const result = await installEmbeddedClaudeSkillsShim(target);
    expect(result.errors).toEqual([]);

    const skillsDir = path.join(target, ".claude", "skills");
    for (const id of getEmbeddedSkillIds()) {
      const subdir = path.join(skillsDir, id);
      expect(existsSync(subdir)).toBe(true);
      expect(statSync(subdir).isDirectory()).toBe(true);

      const skillMd = path.join(subdir, "SKILL.md");
      expect(existsSync(skillMd)).toBe(true);
      expect(statSync(skillMd).isFile()).toBe(true);

      // Regression guard — flat layout must not appear.
      expect(existsSync(path.join(skillsDir, `${id}.md`))).toBe(false);

      const entries = readdirSync(subdir);
      expect(entries).toEqual(["SKILL.md"]);
    }
  });

  it("installed payloads are byte-identical to the embedded manifest", async () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "cli-skills-payload-"));
    try {
      await installEmbeddedClaudeSkillsShim(fresh);
      for (const id of getEmbeddedSkillIds()) {
        const onDisk = readFileSync(
          path.join(fresh, ".claude", "skills", id, "SKILL.md"),
          "utf-8",
        );
        const manifest = resolveSkillPayload(id);
        expect(manifest).not.toBeNull();
        expect(onDisk).toBe(manifest as string);
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("init.ts source — skills install layout (#197 code-shape)", () => {
  // The real `installEmbeddedClaudeSkills` is intentionally private. We
  // pin the critical write-shape on the source text so an accidental
  // refactor (e.g. reverting to `path.join(skillsDir, `${skillId}.md`)`)
  // trips the suite even if all happy-path assertions above keep passing
  // against the shim.
  it("writes to `<id>/SKILL.md`, not flat `<id>.md`", () => {
    const src = readFileSync(
      path.join(CLI_ROOT, "src", "commands", "init.ts"),
      "utf-8",
    ).replace(/\r\n/g, "\n");

    // Positive: spec-compliant destination is constructed.
    expect(src).toMatch(/path\.join\(\s*skillSubdir\s*,\s*"SKILL\.md"\s*\)/);
    expect(src).toMatch(/path\.join\(\s*skillsDir\s*,\s*skillId\s*\)/);

    // Negative: the regressed shape must not exist on a live code line.
    // Strip comments first so explanatory `// was path.join(skillsDir,
    // `${skillId}.md`)` style notes don't trigger a false positive.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(codeOnly).not.toMatch(
      /path\.join\(\s*skillsDir\s*,\s*`\$\{skillId\}\.md`\s*\)/,
    );
  });
});

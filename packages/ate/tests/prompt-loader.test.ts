/**
 * Phase A.3 — prompt-loader unit tests.
 *
 * Uses tmpdir-based fixtures so we don't depend on the canonical catalog.
 * The shape asserted here is the one documented in `prompt-loader.ts` —
 * YAML-like frontmatter with `kind`, `version`, optional `base`, `audience`,
 * `mandu_min`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPrompt, listPrompts, PromptLoadError } from "../src/prompt-loader";

describe("prompt-loader", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ate-prompt-loader-"));
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "filling_unit.v1.md"),
      `---
kind: filling_unit
version: 1
base: mandu_core
audience: LLM
mandu_min: "core@0.30.0"
---

# Role
This is v1.

<!-- EXEMPLAR_SLOT -->
`
    );
    writeFileSync(
      join(dir, "filling_unit.v2.md"),
      `---
kind: filling_unit
version: 2
base: mandu_core
---

# Role
This is v2.
`
    );
    writeFileSync(
      join(dir, "e2e_playwright.v1.md"),
      `---
kind: e2e_playwright
version: 1
---

# Role
Playwright.
`
    );
    // A non-versioned "alias" file — used when no .vN variant exists.
    writeFileSync(
      join(dir, "aliasonly.md"),
      `---
kind: aliasonly
version: 1
---

# Role
Alias.
`
    );

    // Intentionally broken file — should surface on load.
    writeFileSync(
      join(dir, "broken.v1.md"),
      `kind: broken
# no frontmatter fence
`
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadPrompt resolves the highest version when none specified", () => {
    const loaded = loadPrompt("filling_unit", undefined, { dir });
    expect(loaded.frontmatter.kind).toBe("filling_unit");
    expect(loaded.frontmatter.version).toBe(2);
    expect(loaded.body).toContain("This is v2.");
  });

  test("loadPrompt pins an explicit version when requested", () => {
    const loaded = loadPrompt("filling_unit", 1, { dir });
    expect(loaded.frontmatter.version).toBe(1);
    expect(loaded.body).toContain("This is v1.");
    // Sha stable across calls on the same contents.
    const again = loadPrompt("filling_unit", 1, { dir });
    expect(loaded.sha256).toBe(again.sha256);
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("loadPrompt falls back to un-versioned alias when no vN exists", () => {
    const loaded = loadPrompt("aliasonly", undefined, { dir });
    expect(loaded.frontmatter.kind).toBe("aliasonly");
    expect(loaded.body).toContain("Alias.");
  });

  test("loadPrompt throws PromptLoadError for unknown kind", () => {
    expect(() => loadPrompt("not_real", undefined, { dir })).toThrow(PromptLoadError);
    expect(() => loadPrompt("not_real", 1, { dir })).toThrow(PromptLoadError);
    // Broken frontmatter also surfaces.
    expect(() => loadPrompt("broken", 1, { dir })).toThrow(PromptLoadError);
  });

  test("listPrompts enumerates every (kind, version) entry in stable order", () => {
    const entries = listPrompts({ dir });
    const pairs = entries.map((e) => `${e.kind}@${e.version}`);
    // aliasonly.md (no version) is intentionally excluded — only vN entries.
    expect(pairs).toContain("filling_unit@1");
    expect(pairs).toContain("filling_unit@2");
    expect(pairs).toContain("e2e_playwright@1");
    // Stable: alphabetical kind, ascending version.
    const idx1 = pairs.indexOf("filling_unit@1");
    const idx2 = pairs.indexOf("filling_unit@2");
    expect(idx1).toBeLessThan(idx2);
  });
});

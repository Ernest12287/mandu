/**
 * Issue #245 M4 §3.5 — extract / patch / diff helper tests.
 *
 * Cover the three pure surfaces the MCP write-tools layer over:
 *   - `extractDesignTokens()` — color/font/component proposals
 *   - `patchDesignMd()` — section-safe add/update/remove
 *   - `diffDesignSpecs()` — local ↔ upstream per-section diff
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractDesignTokens } from "../extract";
import { patchDesignMd, patchDesignMdBatch } from "../patch";
import { diffDesignSpecs } from "../diff";
import { parseDesignMd } from "../parser";

// ─── extract ──────────────────────────────────────────────────────────

async function setupFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-extract-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src/a.tsx"),
    `const a = "#FF8C42"; const b = "#FF8C42"; const c = "#FF8C42";
const elem = <div className="rounded-lg bg-orange-500 px-4 py-2 text-white" />;`,
  );
  await fs.writeFile(
    path.join(root, "src/b.tsx"),
    `const a = "#FF8C42"; const card = "#FFF8F0";
const elem = <div className="rounded-lg bg-orange-500 px-4 py-2 text-white" />;`,
  );
  await fs.writeFile(
    path.join(root, "app/c.tsx"),
    `const x = "rgb(99,91,255)"; const y = "rgb(99,91,255)"; const z = "rgb(99,91,255)";
const cssIsh = \`font-family: "Inter", sans-serif;\`;
const elem = <div className="rounded-lg bg-orange-500 px-4 py-2 text-white" />;`,
  );
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

describe("extractDesignTokens", () => {
  let fix: { root: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    fix = await setupFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  it("flags colors that occur ≥ minOccurrences", async () => {
    const result = await extractDesignTokens(fix.root);
    const orange = result.proposals.find((p) => p.key === "#ff8c42");
    expect(orange).toBeDefined();
    expect(orange?.section).toBe("color-palette");
    expect(orange?.occurrences).toBeGreaterThanOrEqual(3);
    expect(orange?.confidence).toBeGreaterThan(0);
  });

  it("ignores colors below the threshold", async () => {
    const result = await extractDesignTokens(fix.root, { minOccurrences: 4 });
    expect(result.proposals.find((p) => p.key === "#fff8f0")).toBeUndefined();
  });

  it("flags font-family declarations", async () => {
    const result = await extractDesignTokens(fix.root, { minOccurrences: 1 });
    const inter = result.proposals.find(
      (p) => p.section === "typography" && p.value.includes("Inter"),
    );
    expect(inter).toBeDefined();
  });

  it("flags repeating className combos", async () => {
    const result = await extractDesignTokens(fix.root, { kinds: ["component"] });
    const combo = result.proposals.find((p) => p.section === "components");
    expect(combo).toBeDefined();
    expect(combo?.occurrences).toBeGreaterThanOrEqual(3);
  });

  it("drops proposals already represented in the existing DesignSpec", async () => {
    const existing = parseDesignMd(`# Test
## Color Palette
- Primary — #FF8C42 — brand
`);
    const result = await extractDesignTokens(fix.root, { existing });
    expect(result.proposals.find((p) => p.key === "#ff8c42")).toBeUndefined();
  });
});

// ─── patch ────────────────────────────────────────────────────────────

const SAMPLE = `# Test
## Color Palette
- Primary — #FF8C42 — brand
- Surface — #FFF8F0 — background

## Typography
- body: font-family: "Inter", sans-serif

## Layout
- sm: 0.5rem
`;

describe("patchDesignMd — color-palette", () => {
  it("adds a new token in the right section", () => {
    const r = patchDesignMd(SAMPLE, {
      section: "color-palette",
      operation: "add",
      key: "Accent",
      value: "#1A1F36",
      role: "text",
    });
    expect(r.applied).toBe(true);
    expect(r.next).toContain("- Accent — #1A1F36 — text");
    // Other sections untouched.
    expect(r.next).toContain("## Typography");
    expect(r.next).toContain("## Layout");
  });

  it("refuses to add a duplicate key (slug-insensitive)", () => {
    const r = patchDesignMd(SAMPLE, {
      section: "color-palette",
      operation: "add",
      key: "primary",
      value: "#000",
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toContain("already exists");
  });

  it("updates a matching key", () => {
    const r = patchDesignMd(SAMPLE, {
      section: "color-palette",
      operation: "update",
      key: "Primary",
      value: "#FF7733",
    });
    expect(r.applied).toBe(true);
    expect(r.before).toContain("#FF8C42");
    expect(r.after).toContain("#FF7733");
    expect(r.next).toContain("#FF7733");
    expect(r.next).not.toContain("#FF8C42");
  });

  it("removes a matching key", () => {
    const r = patchDesignMd(SAMPLE, {
      section: "color-palette",
      operation: "remove",
      key: "Surface",
    });
    expect(r.applied).toBe(true);
    expect(r.before).toContain("Surface");
    expect(r.next).not.toContain("Surface");
    // Primary still there.
    expect(r.next).toContain("Primary");
  });

  it("returns no-op + reason when section is absent", () => {
    const r = patchDesignMd("# Empty\n", {
      section: "color-palette",
      operation: "add",
      key: "X",
      value: "#000",
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toContain("not found");
    expect(r.next).toBe("# Empty\n");
  });

  it("requires a value on add/update", () => {
    const r = patchDesignMd(SAMPLE, {
      section: "color-palette",
      operation: "add",
      key: "Foo",
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toContain("required");
  });
});

describe("patchDesignMd — components (H3)", () => {
  it("adds a new component as an H3 heading", () => {
    const r = patchDesignMd(
      `# Test
## Components

### Button
A primary action.
`,
      { section: "components", operation: "add", key: "Card" },
    );
    expect(r.applied).toBe(true);
    expect(r.next).toContain("### Card");
  });
});

describe("patchDesignMdBatch", () => {
  it("applies operations in order against the cumulative source", () => {
    const r = patchDesignMdBatch(SAMPLE, [
      { section: "color-palette", operation: "add", key: "Accent", value: "#000" },
      { section: "color-palette", operation: "remove", key: "Surface" },
      { section: "color-palette", operation: "update", key: "Primary", value: "#111" },
    ]);
    expect(r.appliedCount).toBe(3);
    expect(r.next).toContain("#111");
    expect(r.next).toContain("#000");
    expect(r.next).not.toContain("Surface");
  });

  it("partial success — failed ops surface in results, others still apply", () => {
    const r = patchDesignMdBatch(SAMPLE, [
      { section: "color-palette", operation: "remove", key: "doesnotexist" },
      { section: "color-palette", operation: "add", key: "Accent", value: "#000" },
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.results[0]?.applied).toBe(false);
    expect(r.results[1]?.applied).toBe(true);
  });
});

// ─── diff ─────────────────────────────────────────────────────────────

describe("diffDesignSpecs", () => {
  it("flags added / removed / changed color tokens", () => {
    const local = parseDesignMd(`# A
## Color Palette
- Primary — #FF8C42 — brand
- Surface — #FFF8F0 — background
`);
    const upstream = parseDesignMd(`# B
## Color Palette
- Primary — #FF7733 — brand
- Accent — #1A1F36 — text
`);
    const d = diffDesignSpecs(local, upstream);
    expect(d.colorPalette.find((e) => e.kind === "changed" && e.name === "Primary")).toBeDefined();
    expect(d.colorPalette.find((e) => e.kind === "added" && e.name === "Accent")).toBeDefined();
    expect(d.colorPalette.find((e) => e.kind === "removed" && e.name === "Surface")).toBeDefined();
    expect(d.totalChanges).toBe(3);
  });

  it("returns empty diff when specs are identical at the structured level", () => {
    const a = parseDesignMd(`# T
## Color Palette
- Primary — #FF8C42 — brand
`);
    const b = parseDesignMd(`# Different prose, same tokens
## Color Palette
- Primary — #FF8C42 — brand
`);
    const d = diffDesignSpecs(a, b);
    expect(d.totalChanges).toBe(0);
  });

  it("surfaces section presence changes", () => {
    const local = parseDesignMd(`# A\n## Color Palette\n- Primary — #FF8C42 — brand\n`);
    const upstream = parseDesignMd(
      `# B\n## Color Palette\n- Primary — #FF8C42 — brand\n## Agent Prompts\n### Brand voice\nTone.\n`,
    );
    const d = diffDesignSpecs(local, upstream);
    expect(d.sectionPresenceChanged).toContain("agent-prompts");
  });
});

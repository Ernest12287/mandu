/**
 * Issue #245 M3 — Tailwind v4 `@theme` compiler tests.
 *
 * Pin the contract every other tool (CLI sync, MCP discovery,
 * dev-mode watcher) depends on:
 *
 *   - DESIGN.md tokens → CSS variable naming (Tailwind v4 convention).
 *   - Slug normalisation handles the human-friendly names DESIGN.md
 *     authors actually write.
 *   - Markered region merge preserves user-edited regions.
 *   - Conflicts surface explicitly so the user can reconcile.
 */

import { describe, it, expect } from "bun:test";
import { parseDesignMd } from "../parser";
import {
  compileTailwindTheme,
  mergeThemeIntoCss,
  slugifyTokenName,
  stripMarkeredBlock,
  THEME_MARKER_END,
  THEME_MARKER_START,
} from "../tailwind-theme";

describe("slugifyTokenName", () => {
  it("kebab-cases multi-word names", () => {
    expect(slugifyTokenName("Hot Peach")).toBe("hot-peach");
    expect(slugifyTokenName("Body Small")).toBe("body-small");
    expect(slugifyTokenName("h1 hero")).toBe("h1-hero");
  });

  it("collapses runs of whitespace and underscores", () => {
    expect(slugifyTokenName("primary  color")).toBe("primary-color");
    expect(slugifyTokenName("warm_cream")).toBe("warm-cream");
  });

  it("strips characters that aren't word/space/dash", () => {
    expect(slugifyTokenName("primary!")).toBe("primary");
    expect(slugifyTokenName("orange (500)")).toBe("orange-500");
  });

  it("lowercases ASCII", () => {
    expect(slugifyTokenName("Primary")).toBe("primary");
  });
});

describe("compileTailwindTheme — color palette", () => {
  it("emits --color-<slug> per token", () => {
    const spec = parseDesignMd(`# Test
## Color Palette
- Primary — #FF8C42 — brand accent
- Surface — #FFF8F0 — neutral background
`);
    const compiled = compileTailwindTheme(spec);
    const vars = compiled.entries.map((e) => [e.variable, e.value]);
    expect(vars).toContainEqual(["--color-primary", "#FF8C42"]);
    expect(vars).toContainEqual(["--color-surface", "#FFF8F0"]);
  });

  it("warns and skips tokens with no parseable value", () => {
    const spec = parseDesignMd(`# Test
## Color Palette
- Primary — see Stripe brand docs
- Surface — #FFF8F0
`);
    const compiled = compileTailwindTheme(spec);
    expect(compiled.entries.find((e) => e.variable === "--color-primary")).toBeUndefined();
    expect(compiled.warnings.some((w) => w.kind === "missing-value" && w.tokenName === "Primary")).toBe(true);
  });

  it("flags slug collisions", () => {
    const spec = parseDesignMd(`# Test
## Color Palette
- Primary — #ff0000
- primary — #00ff00
`);
    const compiled = compileTailwindTheme(spec);
    expect(compiled.warnings.some((w) => w.kind === "slug-collision")).toBe(true);
    // First wins.
    expect(compiled.entries.find((e) => e.variable === "--color-primary")?.value).toBe("#ff0000");
  });
});

describe("compileTailwindTheme — emit order + section comments", () => {
  it("groups entries by section with comment dividers", () => {
    const spec = parseDesignMd(`# Test
## Color Palette
- Primary — #FF8C42

## Layout
- sm: 0.5rem
- md: 1rem
`);
    const compiled = compileTailwindTheme(spec);
    expect(compiled.cssBody).toContain("/* Colors */");
    expect(compiled.cssBody).toContain("--color-primary: #FF8C42;");
    expect(compiled.cssBody).toContain("/* Spacing */");
    expect(compiled.cssBody).toContain("--spacing-sm: 0.5rem;");
  });
});

describe("mergeThemeIntoCss", () => {
  it("inserts a fresh markered block when none exists", () => {
    const spec = parseDesignMd(`# Test
## Color Palette
- Primary — #FF8C42
`);
    const compiled = compileTailwindTheme(spec);
    const result = mergeThemeIntoCss("@import 'tailwindcss';\n", compiled);
    expect(result.inserted).toBe(true);
    expect(result.css).toContain(THEME_MARKER_START);
    expect(result.css).toContain(THEME_MARKER_END);
    expect(result.css).toContain("--color-primary: #FF8C42;");
    expect(result.css).toContain("@import 'tailwindcss';");
  });

  it("replaces the markered region only — leaves surrounding content untouched", () => {
    const initial = `@import 'tailwindcss';

/* user comment */
${THEME_MARKER_START}
@theme {
  --color-primary: oldvalue;
}
${THEME_MARKER_END}

.user-class { color: red; }
`;
    const spec = parseDesignMd(`# Test
## Color Palette
- Primary — #FF8C42
`);
    const compiled = compileTailwindTheme(spec);
    const result = mergeThemeIntoCss(initial, compiled);
    expect(result.inserted).toBe(false);
    expect(result.css).toContain("/* user comment */");
    expect(result.css).toContain(".user-class { color: red; }");
    expect(result.css).toContain("--color-primary: #FF8C42;");
    expect(result.css).not.toContain("oldvalue");
  });

  it("flags conflicts when a hand-written @theme variable contradicts DESIGN.md", () => {
    const initial = `@import 'tailwindcss';
@theme {
  --color-primary: #000000;
}
`;
    const spec = parseDesignMd(`# Test
## Color Palette
- Primary — #FF8C42
`);
    const compiled = compileTailwindTheme(spec);
    const result = mergeThemeIntoCss(initial, compiled);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.variable).toBe("--color-primary");
    expect(result.conflicts[0]!.fromDesign).toBe("#FF8C42");
    expect(result.conflicts[0]!.fromCss).toBe("#000000");
  });

  it("emits an empty markered region (no orphans) when DESIGN.md has no tokens", () => {
    const spec = parseDesignMd("# Empty\n");
    const compiled = compileTailwindTheme(spec);
    const result = mergeThemeIntoCss("body { margin: 0; }\n", compiled);
    expect(result.css).toContain(THEME_MARKER_START);
    expect(result.css).toContain(THEME_MARKER_END);
    expect(result.css).toContain("body { margin: 0; }");
  });
});

describe("stripMarkeredBlock", () => {
  it("removes only the markered region", () => {
    const css = `@import 'tailwindcss';
${THEME_MARKER_START}
@theme {
  --color-primary: #FF8C42;
}
${THEME_MARKER_END}
.user { color: red; }
`;
    const result = stripMarkeredBlock(css);
    expect(result).not.toContain("--color-primary");
    expect(result).toContain("@import 'tailwindcss';");
    expect(result).toContain(".user { color: red; }");
  });

  it("is a no-op when no markers are present", () => {
    const css = `@import 'tailwindcss';\n`;
    expect(stripMarkeredBlock(css)).toBe(css);
  });
});

describe("end-to-end — stripe-like DESIGN.md → Tailwind theme", () => {
  it("compiles a full multi-section DESIGN.md into one cohesive @theme", () => {
    const designMd = `# Stripe-like

## Color Palette
- Primary — #635BFF — brand
- Surface — #FFFFFF — page background
- Text — #1A1F36 — body text

## Typography
- body: font-family: "Inter", sans-serif; size: 16px; line-height: 1.5
- h1 hero: font-family: "Inter", sans-serif; size: 48px; line-height: 1.1

## Layout
- xs: 0.25rem
- sm: 0.5rem
- md: 1rem

## Depth & Elevation
- card — 0 1px 3px rgba(0,0,0,0.1)
- modal — 0 25px 50px rgba(0,0,0,0.25)
`;
    const spec = parseDesignMd(designMd);
    const compiled = compileTailwindTheme(spec);

    // Colors
    expect(compiled.cssBody).toContain("--color-primary: #635BFF;");
    expect(compiled.cssBody).toContain("--color-surface: #FFFFFF;");
    // Typography (font + text)
    expect(compiled.cssBody).toContain("--font-body:");
    expect(compiled.cssBody).toContain("--text-h1-hero: 48px / 1.1;");
    // Spacing
    expect(compiled.cssBody).toContain("--spacing-md: 1rem;");
    // Shadows
    expect(compiled.cssBody).toContain("--shadow-card:");
    expect(compiled.cssBody).toContain("--shadow-modal:");
  });
});

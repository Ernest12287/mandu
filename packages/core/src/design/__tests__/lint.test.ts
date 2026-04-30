/**
 * Issue #245 M5 — DESIGN.md lint tests.
 */

import { describe, it, expect } from "bun:test";
import { lintDesignSpec } from "../lint";
import { parseDesignMd } from "../parser";

describe("lintDesignSpec — color-palette", () => {
  it("warns when parser couldn't extract a value (rule: color-missing-value)", () => {
    // Parser drops non-hex/rgb values during extraction, so the
    // resulting token has no `.value` — the linter flags that.
    const r = lintDesignSpec(parseDesignMd(`# T
## Color Palette
- Primary — #FF8C42 — brand
- Bad — notahex — wrong
`));
    expect(
      r.issues.find((i) => i.rule === "color-missing-value" && i.name === "Bad"),
    ).toBeDefined();
  });

  it("warns on missing color value", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Color Palette
- Primary — see docs
`));
    expect(r.issues.find((i) => i.rule === "color-missing-value")?.severity).toBe("warning");
  });

  it("warns on slug collision", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Color Palette
- Primary — #FF0000
- primary — #00FF00
`));
    expect(r.issues.find((i) => i.rule === "color-slug-collision")).toBeDefined();
  });

  it("notes duplicate values across distinct names (info)", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Color Palette
- Brand — #FF8C42 — main
- Accent — #FF8C42 — secondary
`));
    const dup = r.issues.find((i) => i.rule === "color-duplicate-value");
    expect(dup?.severity).toBe("info");
  });
});

describe("lintDesignSpec — typography / layout / shadows / components", () => {
  it("warns on a typography token with neither family nor size", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Typography
- body: weight: 400
`));
    expect(r.issues.find((i) => i.rule === "typography-empty-token")).toBeDefined();
  });

  it("warns on layout slug collision", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Layout
- sm: 0.5rem
- SM: 0.5rem
`));
    expect(r.issues.find((i) => i.rule === "spacing-slug-collision")).toBeDefined();
  });

  it("warns on shadow slug collision", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Depth & Elevation
- card — 0 1px 2px rgba(0,0,0,0.1)
- Card — 0 2px 4px rgba(0,0,0,0.2)
`));
    expect(r.issues.find((i) => i.rule === "shadow-slug-collision")).toBeDefined();
  });

  it("warns on duplicate component H3 names", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Components

### Button

### button
`));
    expect(r.issues.find((i) => i.rule === "component-duplicate")).toBeDefined();
  });
});

describe("lintDesignSpec — clean DESIGN.md", () => {
  it("returns ok with empty issues for a well-formed spec", () => {
    const r = lintDesignSpec(parseDesignMd(`# T
## Color Palette
- Primary — #FF8C42 — brand
- Accent — #1A1F36 — text

## Typography
- body: font-family: Inter, sans-serif; size: 16px

## Layout
- sm: 0.5rem
- md: 1rem

## Depth & Elevation
- card — 0 1px 3px rgba(0,0,0,0.1)
`));
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

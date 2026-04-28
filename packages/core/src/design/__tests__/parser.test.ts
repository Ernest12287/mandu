/**
 * DESIGN.md parser tests.
 *
 * Cover the structural contract: each of the 9 sections is recognised
 * across reasonable formatting variants, and a malformed row never
 * throws — it just gets skipped.
 */
import { describe, it, expect } from "bun:test";
import {
  parseDesignMd,
  validateDesignSpec,
  EMPTY_DESIGN_MD,
  DESIGN_SECTION_IDS,
} from "../index";

describe("parseDesignMd", () => {
  it("parses an empty source without throwing", () => {
    const spec = parseDesignMd("");
    expect(spec.title).toBeUndefined();
    for (const id of DESIGN_SECTION_IDS) {
      expect(spec.sections[id].present).toBe(false);
    }
  });

  it("captures the H1 title", () => {
    const spec = parseDesignMd("# Acme DESIGN.md\n\n## Color Palette\n\n- primary — #000\n");
    expect(spec.title).toBe("Acme DESIGN.md");
    expect(spec.sections["color-palette"].present).toBe(true);
  });

  it("recognises all 9 sections via fuzzy heading matching", () => {
    const md = `# X

## Visual Theme & Philosophy
Minimal and dense.

## Color Palette
- primary — #FF8C42 — brand action

## Typography
- display — Inter, 48px, weight 700 — hero

## Components
### Button
variant: primary | secondary | ghost

## Layout
- md — 16px

## Depth & Elevation
- card: 0 1px 2px rgba(0,0,0,.06)

## Do's & Don'ts
### Do
- Use tokens

### Don't
- Inline btn-hard

## Responsive
- mobile — 640px

## Agent Prompts
### hero
Generate using display token.
`;
    const spec = parseDesignMd(md);
    expect(spec.sections.theme.present).toBe(true);
    expect(spec.sections.theme.summary).toBe("Minimal and dense.");
    expect(spec.sections["color-palette"].tokens).toEqual([
      { name: "primary", value: "#FF8C42", role: "brand action" },
    ]);
    expect(spec.sections.typography.tokens[0]?.name).toBe("display");
    expect(spec.sections.typography.tokens[0]?.size).toBe("48px");
    expect(spec.sections.components.tokens[0]?.name).toBe("Button");
    expect(spec.sections.components.tokens[0]?.variants.variant).toEqual([
      "primary",
      "secondary",
      "ghost",
    ]);
    expect(spec.sections.layout.tokens[0]).toEqual({ name: "md", value: "16px" });
    expect(spec.sections.shadows.tokens[0]?.name).toBe("card");
    expect(spec.sections["dos-donts"].rules.find((r) => r.kind === "do")?.text).toBe(
      "Use tokens",
    );
    expect(spec.sections["dos-donts"].rules.find((r) => r.kind === "dont")?.text).toBe(
      "Inline btn-hard",
    );
    expect(spec.sections.responsive.breakpoints[0]).toEqual({
      name: "mobile",
      value: "640px",
      notes: undefined,
    });
    expect(spec.sections["agent-prompts"].prompts[0]?.title).toBe("hero");
  });

  it("treats unknown H2 sections as extras (round-trip)", () => {
    const md = `## Color Palette\n- primary — #000\n\n## Internationalization\nKO + EN only.\n`;
    const spec = parseDesignMd(md);
    expect(spec.sections["color-palette"].present).toBe(true);
    expect(spec.extraSections).toHaveLength(1);
    expect(spec.extraSections[0]?.heading).toBe("Internationalization");
  });

  it("absorbs malformed rows without throwing", () => {
    const md = `## Color Palette
- primary — #FF8C42 — brand
- garbage row with no shape at all
- — — — —
- accent — not-a-color — ok
`;
    expect(() => parseDesignMd(md)).not.toThrow();
    const spec = parseDesignMd(md);
    const tokens = spec.sections["color-palette"].tokens;
    // primary (with hex) survives. accent (no hex) is captured with name+role only.
    expect(tokens.find((t) => t.name === "primary")?.value).toBe("#FF8C42");
    expect(tokens.length).toBeGreaterThanOrEqual(1);
  });

  it("supports markdown table rows for color palette", () => {
    const md = `## Color Palette
| Name | Hex | Role |
|------|-----|------|
| primary | #000000 | brand |
| surface | #ffffff | background |
`;
    const spec = parseDesignMd(md);
    const names = spec.sections["color-palette"].tokens.map((t) => t.name);
    expect(names).toContain("primary");
    expect(names).toContain("surface");
  });

  it("parses the empty skeleton without finding tokens", () => {
    const spec = parseDesignMd(EMPTY_DESIGN_MD);
    expect(spec.title).toBe("DESIGN.md");
    // All sections are present (headings exist) but have no structured tokens.
    for (const id of DESIGN_SECTION_IDS) {
      expect(spec.sections[id].present).toBe(true);
    }
    expect(spec.sections["color-palette"].tokens).toEqual([]);
  });
});

describe("validateDesignSpec", () => {
  it("flags empty source with all 9 missing", () => {
    const result = validateDesignSpec(parseDesignMd(""));
    expect(result.ok).toBe(false);
    expect(result.issues.filter((i) => i.kind === "missing")).toHaveLength(9);
  });

  it("flags the empty skeleton as `empty` for every section", () => {
    const result = validateDesignSpec(parseDesignMd(EMPTY_DESIGN_MD));
    // All sections present, all empty — so no `missing`, all `empty`.
    expect(result.issues.every((i) => i.kind === "empty")).toBe(true);
    expect(result.issues).toHaveLength(9);
  });

  it("returns ok=true when every section has structured content", () => {
    const md = `# X

## Visual Theme & Philosophy
Minimal.

## Color Palette
- primary — #000

## Typography
- body — Inter, 16px

## Components
### Button
variant: primary | secondary

## Layout
- md — 16px

## Depth & Elevation
- card: 0 1px 2px rgba(0,0,0,.06)

## Do's & Don'ts
### Do
- Use tokens

## Responsive
- mobile — 640px

## Agent Prompts
### default
Use tokens.
`;
    const result = validateDesignSpec(parseDesignMd(md));
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

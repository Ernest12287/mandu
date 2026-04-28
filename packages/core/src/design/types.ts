/**
 * DESIGN.md type surface.
 *
 * The 9-section schema is borrowed verbatim from Google Stitch's
 * DESIGN.md convention (also used by VoltAgent's awesome-design-md
 * catalog of 69 brand spec files). Mandu adopts it as a first-class
 * format rather than inventing its own — see Issue #245 v2 plan.
 *
 * Parsing is **permissive**: a DESIGN.md may include any subset of
 * sections, in any order, with arbitrary free-form content between
 * structured tokens. The parser populates the sections it understands
 * and stores the rest as `rawBody` so round-trips don't lose user
 * prose. Tools (Guard, MCP, token bridge) consume only the structured
 * fields they care about.
 *
 * @module core/design/types
 */

export const DESIGN_SECTION_IDS = [
  "theme",
  "color-palette",
  "typography",
  "components",
  "layout",
  "shadows",
  "dos-donts",
  "responsive",
  "agent-prompts",
] as const;

export type DesignSectionId = (typeof DESIGN_SECTION_IDS)[number];

/**
 * Color palette entry. `hex` may be missing when a row only carries a
 * semantic role (e.g. "primary — brand color, see Stripe docs"); the
 * Guard rule and the token bridge skip rows without a parseable value.
 */
export interface ColorToken {
  name: string;
  /** `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, `oklch(...)`, etc. */
  value?: string;
  /** Functional role — "primary", "surface", "text-muted", … (free-form). */
  role?: string;
}

export interface TypographyToken {
  name: string;
  fontFamily?: string;
  weight?: string;
  size?: string;
  lineHeight?: string;
  /** Free-form usage hint ("h1 hero", "body small", …). */
  usage?: string;
}

export interface ComponentToken {
  name: string;
  /** Variants surfaced as a `name → list` map. Empty when not declared. */
  variants: Record<string, string[]>;
  /** Free-form description / props notes from markdown body. */
  notes?: string;
}

export interface SpacingToken {
  /** "xs", "sm", "md", "lg", "xl" — caller-defined. */
  name: string;
  value?: string;
}

export interface ShadowToken {
  /** "card", "popover", "modal" — caller-defined elevation name. */
  name: string;
  value?: string;
  /** Free-form usage hint. */
  usage?: string;
}

export interface DoDontRule {
  /** "do" or "dont" — Guard rule consumes "dont" as `forbidInlineClasses` candidates. */
  kind: "do" | "dont";
  /** Plain-text rule body. */
  text: string;
}

export interface ResponsiveBreakpoint {
  name: string;
  value?: string;
  /** Free-form notes (touch target, scaling strategy, …). */
  notes?: string;
}

export interface AgentPrompt {
  /** Heading or first sentence used as a label. */
  title: string;
  /** Body of the prompt — passed through verbatim. */
  body: string;
}

/**
 * Per-section payload. Every section carries:
 *   - `present`: whether the heading was found at all
 *   - `rawBody`: original markdown body for round-trip / fallback
 *   - structured fields where applicable (`tokens`, `rules`, …)
 *
 * Tools that only care about presence (e.g. `mandu design validate`)
 * read `present`; structured consumers (Guard, token bridge) read the
 * typed fields and treat empties as "not declared".
 */
export interface DesignSection {
  id: DesignSectionId;
  present: boolean;
  /** Heading line as written by the user (e.g. "## Color Palette"). */
  headingText?: string;
  /** Raw markdown body between this heading and the next H2. */
  rawBody: string;
}

export interface ThemeSection extends DesignSection {
  id: "theme";
  /** First non-empty paragraph — quick "vibe" answer. */
  summary?: string;
}

export interface ColorPaletteSection extends DesignSection {
  id: "color-palette";
  tokens: ColorToken[];
}

export interface TypographySection extends DesignSection {
  id: "typography";
  tokens: TypographyToken[];
}

export interface ComponentsSection extends DesignSection {
  id: "components";
  tokens: ComponentToken[];
}

export interface LayoutSection extends DesignSection {
  id: "layout";
  tokens: SpacingToken[];
}

export interface ShadowsSection extends DesignSection {
  id: "shadows";
  tokens: ShadowToken[];
}

export interface DosDontsSection extends DesignSection {
  id: "dos-donts";
  rules: DoDontRule[];
}

export interface ResponsiveSection extends DesignSection {
  id: "responsive";
  breakpoints: ResponsiveBreakpoint[];
}

export interface AgentPromptsSection extends DesignSection {
  id: "agent-prompts";
  prompts: AgentPrompt[];
}

export type AnyDesignSection =
  | ThemeSection
  | ColorPaletteSection
  | TypographySection
  | ComponentsSection
  | LayoutSection
  | ShadowsSection
  | DosDontsSection
  | ResponsiveSection
  | AgentPromptsSection;

export interface DesignSpec {
  /** Original source string (for round-trip). */
  source: string;
  /**
   * Sections in canonical order. `present: false` when the user omitted
   * the section — Mandu still reserves the slot so consumers can index
   * by id without `find()`.
   */
  sections: {
    theme: ThemeSection;
    "color-palette": ColorPaletteSection;
    typography: TypographySection;
    components: ComponentsSection;
    layout: LayoutSection;
    shadows: ShadowsSection;
    "dos-donts": DosDontsSection;
    responsive: ResponsiveSection;
    "agent-prompts": AgentPromptsSection;
  };
  /** Extra H2 sections the user wrote that don't map to the 9-section spec. */
  extraSections: Array<{ heading: string; body: string }>;
  /** Optional H1 title at the top of the file. */
  title?: string;
}

export interface ValidationIssue {
  /** "missing" — section absent. "empty" — section present but no structured tokens. "malformed" — parse error inside a section. */
  kind: "missing" | "empty" | "malformed";
  section: DesignSectionId;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

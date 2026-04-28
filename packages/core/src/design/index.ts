/**
 * `@mandujs/core/design` — DESIGN.md primitives.
 *
 * Public surface for Issue #245 M1 (parser + scaffold + import +
 * validate). Other modules — Guard rule, MCP discovery, token bridge —
 * consume `parseDesignMd` and the `DesignSpec` type.
 *
 * @module core/design
 */

export {
  parseDesignMd,
  validateDesignSpec,
  humanizeSectionId,
} from "./parser";

export {
  EMPTY_DESIGN_MD,
  fetchUpstreamDesignMd,
  AWESOME_DESIGN_MD_RAW_BASE,
} from "./scaffold";

export type {
  AgentPrompt,
  AgentPromptsSection,
  AnyDesignSection,
  ColorPaletteSection,
  ColorToken,
  ComponentToken,
  ComponentsSection,
  DesignSection,
  DesignSectionId,
  DesignSpec,
  DoDontRule,
  DosDontsSection,
  LayoutSection,
  ResponsiveBreakpoint,
  ResponsiveSection,
  ShadowToken,
  ShadowsSection,
  SpacingToken,
  ThemeSection,
  TypographyToken,
  TypographySection,
  ValidationIssue,
  ValidationResult,
} from "./types";

export { DESIGN_SECTION_IDS } from "./types";

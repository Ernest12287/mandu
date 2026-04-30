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

export {
  compileTailwindTheme,
  mergeThemeIntoCss,
  stripMarkeredBlock,
  slugifyTokenName,
  THEME_MARKER_START,
  THEME_MARKER_END,
  type CompiledTheme,
  type CompiledThemeEntry,
  type CompiledThemeWarning,
  type ThemeMergeConflict,
  type ThemeMergeResult,
} from "./tailwind-theme";

export {
  extractDesignTokens,
  type ExtractKind,
  type ExtractOptions,
  type ExtractProposal,
  type ExtractResult,
} from "./extract";

export {
  patchDesignMd,
  patchDesignMdBatch,
  type PatchableSection,
  type PatchOperation,
  type PatchResult,
  type PatchBatchResult,
} from "./patch";

export {
  diffDesignSpecs,
  type DesignSpecDiff,
  type DiffEntry,
} from "./diff";

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

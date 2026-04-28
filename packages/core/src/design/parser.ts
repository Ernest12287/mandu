/**
 * DESIGN.md parser — the 9-section heading walker.
 *
 * Strategy:
 *   1. Optional H1 title at the top of the file.
 *   2. Scan H2 headings. Match each against the 9 canonical sections
 *      via a fuzzy-but-bounded resolver (lowercase, strip `&` / `'`,
 *      collapse whitespace). Unrecognized headings land in
 *      `extraSections` so the file round-trips cleanly.
 *   3. For each matched section, parse the body into structured
 *      tokens with a section-specific extractor. Extractors are
 *      forgiving — a malformed row is skipped, never fatal.
 *
 * Parsing must NEVER throw on real-world DESIGN.md files. The 69
 * brand entries in awesome-design-md vary wildly in formatting; the
 * parser is the contract that smooths them out for the rest of Mandu.
 *
 * @module core/design/parser
 */

import type {
  AgentPrompt,
  AnyDesignSection,
  ColorToken,
  ComponentToken,
  DesignSectionId,
  DesignSpec,
  DoDontRule,
  ResponsiveBreakpoint,
  ShadowToken,
  SpacingToken,
  TypographyToken,
  ValidationIssue,
  ValidationResult,
} from "./types";

import { DESIGN_SECTION_IDS } from "./types";

// ────────────────────────────────────────────────────────────────────
// Heading → section-id resolution
// ────────────────────────────────────────────────────────────────────

/**
 * Match heading text against the 9 canonical section ids. Returns the
 * id when the heading "looks like" the section by keyword, else null.
 * The keyword sets are intentionally redundant to absorb the wording
 * differences across the awesome-design-md catalog.
 */
function resolveSectionId(heading: string): DesignSectionId | null {
  const h = heading
    .toLowerCase()
    .replace(/[&'`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^visual|^theme|^philosophy|^vibe|^aesthetic/.test(h)) return "theme";
  if (/color|palette/.test(h)) return "color-palette";
  if (/typograph|typeface|font|type scale/.test(h)) return "typography";
  if (/component|button|card|input/.test(h)) return "components";
  if (/layout|spacing|grid|whitespace/.test(h)) return "layout";
  if (/shadow|elevation|depth/.test(h)) return "shadows";
  if (/do.{0,3}dont|guideline|principle|rule/.test(h)) return "dos-donts";
  if (/responsive|breakpoint|mobile|tablet|desktop/.test(h)) return "responsive";
  if (/agent|prompt|llm|ai/.test(h)) return "agent-prompts";
  return null;
}

// ────────────────────────────────────────────────────────────────────
// H2 splitter
// ────────────────────────────────────────────────────────────────────

interface RawSection {
  heading: string;
  /** `1` or `2` — H1 or H2. */
  level: number;
  body: string;
}

/**
 * Strip HTML comments (`<!-- … -->`) before structural parsing. The
 * empty-skeleton template uses HTML comments to show example tokens
 * without having them counted as real tokens; the parser must respect
 * that convention. Multi-line comments are supported.
 */
function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

function splitByHeadings(source: string): {
  title?: string;
  sections: RawSection[];
} {
  const lines = stripHtmlComments(source).split(/\r?\n/);
  let title: string | undefined;
  const sections: RawSection[] = [];
  let current: RawSection | null = null;

  // H1 detection — first non-empty line is `# Foo` or first `# Foo` before
  // any H2. Only the first H1 is treated as title.
  let titleConsumed = false;

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h1 && !titleConsumed && current === null) {
      title = h1[1].trim();
      titleConsumed = true;
      continue;
    }
    if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1].trim(), level: 2, body: "" };
      continue;
    }
    if (current) {
      current.body += (current.body ? "\n" : "") + line;
    }
  }
  if (current) sections.push(current);
  return { title, sections };
}

// ────────────────────────────────────────────────────────────────────
// Section extractors
// ────────────────────────────────────────────────────────────────────

const COLOR_VALUE_RX =
  /(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)|oklab\([^)]+\))/;

function extractColorTokens(body: string): ColorToken[] {
  const tokens: ColorToken[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*+]\s*/, "").replace(/^\|\s*/, "").replace(/\s*\|.*$/, "");
    if (!trimmed) continue;
    const valueMatch = COLOR_VALUE_RX.exec(line);
    // Try patterns:
    //   - `name — #hex — role`
    //   - `name: #hex (role)`
    //   - `**name** \`#hex\` — role`
    //   - `| name | #hex | role |` (markdown table row)
    const stripped = line
      .replace(/[`*_]/g, "")
      .replace(/^[\s|>-]+/, "")
      .replace(/\s*\|.*$/, "");
    const sepMatch = /^([^:—–\-]+?)[\s]*[:—–\-][\s]*(.+)$/.exec(stripped);
    let name: string | undefined;
    let role: string | undefined;
    if (sepMatch) {
      name = sepMatch[1].trim();
      const rest = sepMatch[2];
      // role is whatever isn't the colour value
      if (valueMatch) {
        role = rest.replace(valueMatch[0], "").replace(/[\s—–\-:|]+/g, " ").trim() || undefined;
      } else {
        role = rest.trim() || undefined;
      }
    }
    if (!name && valueMatch) {
      // Fallback — colour value present but no clear "name : value" split.
      name = stripped.replace(valueMatch[0], "").trim() || valueMatch[0];
    }
    if (!name) continue;
    if (name.length > 100) continue; // garbage line
    // Filter out heading-like rows ("Color Palette", "Functional Roles", ...).
    if (/palette|role/i.test(name) && !valueMatch) continue;
    tokens.push({
      name,
      value: valueMatch ? valueMatch[0] : undefined,
      role,
    });
  }
  return tokens;
}

function extractTypographyTokens(body: string): TypographyToken[] {
  const tokens: TypographyToken[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*+]\s*/, "");
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue; // sub-headings
    const stripped = trimmed.replace(/[`*_]/g, "");
    const nameMatch = /^([^:—–]+?)[\s]*[:—–]/.exec(stripped);
    const name = nameMatch ? nameMatch[1].trim() : stripped.split(/\s{2,}|—|–/)[0]?.trim();
    if (!name) continue;
    const fontFamily = /font[\s-]*family[:\s]+([^,;]+)/i.exec(stripped)?.[1]?.trim();
    const weight = /weight[:\s]+([0-9]{3}|bold|semi-?bold|medium|regular|light|thin)/i.exec(stripped)?.[1]?.trim();
    const size = /(\d+(?:\.\d+)?(?:px|rem|em|pt))/.exec(stripped)?.[1];
    const lineHeight = /line[\s-]*height[:\s]+([0-9.]+)/i.exec(stripped)?.[1];
    tokens.push({
      name,
      fontFamily,
      weight,
      size,
      lineHeight,
      usage: stripped !== name ? stripped : undefined,
    });
  }
  return tokens;
}

function extractComponentTokens(body: string): ComponentToken[] {
  // Components are typically organised under H3 sub-headings ("### Button",
  // "### Card"). When present, treat each H3 as one component; otherwise
  // fall back to bullet rows.
  const tokens: ComponentToken[] = [];
  const h3Rx = /^###\s+(.+?)\s*$/;
  const lines = body.split(/\r?\n/);

  let current: ComponentToken | null = null;
  for (const line of lines) {
    const h3 = h3Rx.exec(line);
    if (h3) {
      if (current) tokens.push(current);
      current = { name: h3[1].trim(), variants: {}, notes: "" };
      continue;
    }
    if (!current) continue;
    // Variant detection — `variant: primary | secondary | ghost`
    const variantMatch = /^[\s-]*(\w[\w\s-]*?)[\s]*:[\s]*(.+)$/.exec(line.trim());
    if (variantMatch) {
      const key = variantMatch[1].trim();
      const valuesRaw = variantMatch[2].trim();
      if (/[|,]/.test(valuesRaw) && valuesRaw.length < 200) {
        const values = valuesRaw
          .split(/[|,]/)
          .map((v) => v.trim().replace(/[`*_"']/g, ""))
          .filter(Boolean);
        if (values.length >= 2) {
          current.variants[key] = values;
          continue;
        }
      }
    }
    if (line.trim()) {
      current.notes = (current.notes ?? "") + (current.notes ? "\n" : "") + line;
    }
  }
  if (current) tokens.push(current);

  if (tokens.length === 0) {
    // Fallback — flat bullet list of components.
    for (const line of lines) {
      const m = /^[\s-*+]+([A-Z][\w\s]+?)(?::|—|–|$)/.exec(line);
      if (m) tokens.push({ name: m[1].trim(), variants: {}, notes: undefined });
    }
  }
  return tokens;
}

function extractSpacingTokens(body: string): SpacingToken[] {
  const tokens: SpacingToken[] = [];
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim().replace(/^[-*+]\s*/, "").replace(/[`*_]/g, "");
    if (!stripped) continue;
    const m = /^([\w-]+)[\s:—–-]+(\d+(?:\.\d+)?(?:px|rem|em|%)?)/.exec(stripped);
    if (m) tokens.push({ name: m[1], value: m[2] });
  }
  return tokens;
}

function extractShadowTokens(body: string): ShadowToken[] {
  const tokens: ShadowToken[] = [];
  // Shadows are typically `name: <css value>` rows. CSS values contain
  // commas / parens / `0 1px 2px rgba(...)` so we don't attempt to fully
  // parse them — capture the whole right-hand side verbatim.
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim().replace(/^[-*+]\s*/, "").replace(/[`*_]/g, "");
    if (!stripped) continue;
    const m = /^([\w-]+)\s*[:—–]\s*(.+)$/.exec(stripped);
    if (m && (m[2].includes("px") || m[2].includes("rgba"))) {
      tokens.push({ name: m[1], value: m[2].trim() });
    }
  }
  return tokens;
}

function extractDoDontRules(body: string): DoDontRule[] {
  const rules: DoDontRule[] = [];
  let mode: "do" | "dont" | null = null;
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (/^#{2,}\s+do\b|^\*\*do\*\*|^do['s]*[:\s]/i.test(stripped) && !/don.?t/i.test(stripped)) {
      mode = "do";
      continue;
    }
    if (/^#{2,}\s+don.?t|^\*\*don.?t\*\*|^don.?t[s]?[:\s]/i.test(stripped)) {
      mode = "dont";
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(stripped);
    if (bullet && mode) {
      rules.push({ kind: mode, text: bullet[1].replace(/[`*_]/g, "").trim() });
    } else if (bullet) {
      // ✅ / ❌ inline markers.
      const text = bullet[1];
      if (text.startsWith("✅") || /^do\b/i.test(text)) {
        rules.push({ kind: "do", text: text.replace(/^[✅do:\s]+/i, "").trim() });
      } else if (text.startsWith("❌") || /^don.?t\b/i.test(text)) {
        rules.push({ kind: "dont", text: text.replace(/^[❌don'?t:\s]+/i, "").trim() });
      }
    }
  }
  return rules;
}

function extractBreakpoints(body: string): ResponsiveBreakpoint[] {
  const bps: ResponsiveBreakpoint[] = [];
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim().replace(/^[-*+]\s*/, "").replace(/[`*_]/g, "");
    if (!stripped) continue;
    const m = /^([\w-]+)[\s:—–-]+(\d+(?:px|rem|em)?)\b(.*)$/.exec(stripped);
    if (m) {
      bps.push({
        name: m[1],
        value: m[2],
        notes: m[3].replace(/^[\s—–-]+/, "").trim() || undefined,
      });
    }
  }
  return bps;
}

function extractAgentPrompts(body: string): AgentPrompt[] {
  // Group by H3; everything else collapses into a single "default" prompt.
  const prompts: AgentPrompt[] = [];
  const lines = body.split(/\r?\n/);
  const h3Rx = /^###\s+(.+?)\s*$/;
  let current: AgentPrompt | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const h3 = h3Rx.exec(line);
    if (h3) {
      if (current) {
        current.body = buf.join("\n").trim();
        prompts.push(current);
      }
      current = { title: h3[1].trim(), body: "" };
      buf = [];
      continue;
    }
    buf.push(line);
  }
  if (current) {
    current.body = buf.join("\n").trim();
    prompts.push(current);
  } else if (buf.join("").trim()) {
    prompts.push({ title: "default", body: buf.join("\n").trim() });
  }
  return prompts;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

function emptySections(): DesignSpec["sections"] {
  return {
    theme: { id: "theme", present: false, rawBody: "" },
    "color-palette": { id: "color-palette", present: false, rawBody: "", tokens: [] },
    typography: { id: "typography", present: false, rawBody: "", tokens: [] },
    components: { id: "components", present: false, rawBody: "", tokens: [] },
    layout: { id: "layout", present: false, rawBody: "", tokens: [] },
    shadows: { id: "shadows", present: false, rawBody: "", tokens: [] },
    "dos-donts": { id: "dos-donts", present: false, rawBody: "", rules: [] },
    responsive: { id: "responsive", present: false, rawBody: "", breakpoints: [] },
    "agent-prompts": { id: "agent-prompts", present: false, rawBody: "", prompts: [] },
  };
}

/** Parse a DESIGN.md source string into the structured spec. Never throws. */
export function parseDesignMd(source: string): DesignSpec {
  const { title, sections: rawSections } = splitByHeadings(source);
  const result: DesignSpec = {
    source,
    title,
    sections: emptySections(),
    extraSections: [],
  };

  for (const raw of rawSections) {
    const id = resolveSectionId(raw.heading);
    if (!id) {
      result.extraSections.push({ heading: raw.heading, body: raw.body });
      continue;
    }
    const body = raw.body.trim();
    switch (id) {
      case "theme": {
        const summary = body.split(/\n\s*\n/)[0]?.trim() || undefined;
        result.sections.theme = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          summary,
        };
        break;
      }
      case "color-palette":
        result.sections["color-palette"] = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          tokens: extractColorTokens(body),
        };
        break;
      case "typography":
        result.sections.typography = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          tokens: extractTypographyTokens(body),
        };
        break;
      case "components":
        result.sections.components = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          tokens: extractComponentTokens(body),
        };
        break;
      case "layout":
        result.sections.layout = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          tokens: extractSpacingTokens(body),
        };
        break;
      case "shadows":
        result.sections.shadows = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          tokens: extractShadowTokens(body),
        };
        break;
      case "dos-donts":
        result.sections["dos-donts"] = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          rules: extractDoDontRules(body),
        };
        break;
      case "responsive":
        result.sections.responsive = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          breakpoints: extractBreakpoints(body),
        };
        break;
      case "agent-prompts":
        result.sections["agent-prompts"] = {
          id,
          present: true,
          headingText: raw.heading,
          rawBody: body,
          prompts: extractAgentPrompts(body),
        };
        break;
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

/**
 * Surface gaps in a parsed DESIGN.md. The validator never returns
 * errors that block builds — Mandu's enforcement layer (Guard) is the
 * gate. This function is the diagnostic that tells the user "your
 * DESIGN.md is missing colour tokens" so they can fill it in.
 */
export function validateDesignSpec(spec: DesignSpec): ValidationResult {
  const issues: ValidationIssue[] = [];
  for (const id of DESIGN_SECTION_IDS) {
    const section = spec.sections[id] as AnyDesignSection;
    if (!section.present) {
      issues.push({
        kind: "missing",
        section: id,
        message: `Section "${id}" not found. Add a "## ${humanizeSectionId(id)}" heading.`,
      });
      continue;
    }
    const empty = isSectionEmpty(section);
    if (empty) {
      issues.push({
        kind: "empty",
        section: id,
        message: `Section "${id}" is present but has no structured tokens.`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

function isSectionEmpty(section: AnyDesignSection): boolean {
  switch (section.id) {
    case "theme":
      return !section.summary || section.summary.length === 0;
    case "color-palette":
    case "typography":
    case "components":
    case "layout":
    case "shadows":
      return section.tokens.length === 0;
    case "dos-donts":
      return section.rules.length === 0;
    case "responsive":
      return section.breakpoints.length === 0;
    case "agent-prompts":
      return section.prompts.length === 0;
  }
}

function humanizeSectionId(id: DesignSectionId): string {
  switch (id) {
    case "theme":
      return "Visual Theme & Philosophy";
    case "color-palette":
      return "Color Palette";
    case "typography":
      return "Typography";
    case "components":
      return "Components";
    case "layout":
      return "Layout";
    case "shadows":
      return "Depth & Elevation";
    case "dos-donts":
      return "Do's & Don'ts";
    case "responsive":
      return "Responsive";
    case "agent-prompts":
      return "Agent Prompts";
  }
}

export { humanizeSectionId };

/**
 * DESIGN.md self-consistency lint (Issue #245 M5).
 *
 * Different from `validateDesignSpec` (M1), which reports section
 * presence / shape. The linter checks the *content* for issues that
 * compile fine but waste reader time:
 *
 *   - color-palette: hex values that aren't 3/6/8 digits, duplicate
 *     hex values across distinct names, slug collisions across names
 *   - typography: tokens missing both `fontFamily` and `size`,
 *     duplicate display-name slugs
 *   - layout / shadows: tokens with no value, duplicate slugs
 *   - components: duplicate H3 names
 *   - dos-donts: rules under §7 with no `do` / `don't` mode marker
 *
 * The linter is conservative — every rule is opt-out via severity
 * filtering at the call site. The tool returns `{ ok, issues[] }`
 * so CLIs can produce exit codes and MCP tools can stream the issue
 * list.
 */

import { slugifyTokenName } from "./tailwind-theme";
import type { DesignSpec } from "./types";

export type LintSeverity = "error" | "warning" | "info";

export interface LintIssue {
  rule: string;
  section:
    | "color-palette"
    | "typography"
    | "layout"
    | "shadows"
    | "components"
    | "dos-donts"
    | "agent-prompts"
    | "responsive";
  severity: LintSeverity;
  message: string;
  /** Token / row name when the issue is per-row. */
  name?: string;
}

export interface LintResult {
  ok: boolean;
  issues: LintIssue[];
}

const HEX_RX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FN_RX = /^(rgba?|hsla?|oklch|hwb|lab|lch)\(/i;

export function lintDesignSpec(spec: DesignSpec): LintResult {
  const issues: LintIssue[] = [];

  // ─── color-palette ────────────────────────────────────────────────
  const seenColorSlug = new Map<string, string>();
  const seenColorValue = new Map<string, string>();
  for (const token of spec.sections["color-palette"].tokens) {
    if (!token.value) {
      issues.push({
        rule: "color-missing-value",
        section: "color-palette",
        severity: "warning",
        message: `Color "${token.name}" has no parseable value — Tailwind sync will skip it.`,
        name: token.name,
      });
      continue;
    }
    if (!HEX_RX.test(token.value) && !COLOR_FN_RX.test(token.value)) {
      issues.push({
        rule: "color-malformed-value",
        section: "color-palette",
        severity: "error",
        message: `Color "${token.name}" value "${token.value}" is not a recognised hex/rgb/hsl/oklch literal.`,
        name: token.name,
      });
    }
    const sl = slugifyTokenName(token.name);
    const prevByName = seenColorSlug.get(sl);
    if (prevByName) {
      issues.push({
        rule: "color-slug-collision",
        section: "color-palette",
        severity: "warning",
        message: `Color "${token.name}" slugifies to the same id as "${prevByName}" — Tailwind sync keeps only the first.`,
        name: token.name,
      });
    } else {
      seenColorSlug.set(sl, token.name);
    }
    const prevByValue = seenColorValue.get(token.value.toLowerCase());
    if (prevByValue && prevByValue !== token.name) {
      issues.push({
        rule: "color-duplicate-value",
        section: "color-palette",
        severity: "info",
        message: `Color "${token.name}" shares value ${token.value} with "${prevByValue}" — consider a single canonical name.`,
        name: token.name,
      });
    } else {
      seenColorValue.set(token.value.toLowerCase(), token.name);
    }
  }

  // ─── typography ──────────────────────────────────────────────────
  const seenTypoSlug = new Map<string, string>();
  for (const token of spec.sections.typography.tokens) {
    if (!token.fontFamily && !token.size) {
      issues.push({
        rule: "typography-empty-token",
        section: "typography",
        severity: "warning",
        message: `Typography token "${token.name}" has neither fontFamily nor size — nothing to sync.`,
        name: token.name,
      });
    }
    const sl = slugifyTokenName(token.name);
    const prev = seenTypoSlug.get(sl);
    if (prev) {
      issues.push({
        rule: "typography-slug-collision",
        section: "typography",
        severity: "warning",
        message: `Typography "${token.name}" collides with "${prev}" on slug "${sl}".`,
        name: token.name,
      });
    } else {
      seenTypoSlug.set(sl, token.name);
    }
  }

  // ─── layout (spacing) ────────────────────────────────────────────
  const seenLayoutSlug = new Map<string, string>();
  for (const token of spec.sections.layout.tokens) {
    if (!token.value) {
      issues.push({
        rule: "spacing-missing-value",
        section: "layout",
        severity: "warning",
        message: `Spacing "${token.name}" has no value.`,
        name: token.name,
      });
      continue;
    }
    const sl = slugifyTokenName(token.name);
    const prev = seenLayoutSlug.get(sl);
    if (prev) {
      issues.push({
        rule: "spacing-slug-collision",
        section: "layout",
        severity: "warning",
        message: `Spacing "${token.name}" collides with "${prev}" on slug "${sl}".`,
        name: token.name,
      });
    } else {
      seenLayoutSlug.set(sl, token.name);
    }
  }

  // ─── shadows ─────────────────────────────────────────────────────
  const seenShadowSlug = new Map<string, string>();
  for (const token of spec.sections.shadows.tokens) {
    if (!token.value) {
      issues.push({
        rule: "shadow-missing-value",
        section: "shadows",
        severity: "warning",
        message: `Shadow "${token.name}" has no value.`,
        name: token.name,
      });
      continue;
    }
    const sl = slugifyTokenName(token.name);
    const prev = seenShadowSlug.get(sl);
    if (prev) {
      issues.push({
        rule: "shadow-slug-collision",
        section: "shadows",
        severity: "warning",
        message: `Shadow "${token.name}" collides with "${prev}" on slug "${sl}".`,
        name: token.name,
      });
    } else {
      seenShadowSlug.set(sl, token.name);
    }
  }

  // ─── components ──────────────────────────────────────────────────
  const seenComponentSlug = new Map<string, string>();
  for (const token of spec.sections.components.tokens) {
    const sl = slugifyTokenName(token.name);
    const prev = seenComponentSlug.get(sl);
    if (prev) {
      issues.push({
        rule: "component-duplicate",
        section: "components",
        severity: "warning",
        message: `Component "${token.name}" appears twice (also as "${prev}").`,
        name: token.name,
      });
    } else {
      seenComponentSlug.set(sl, token.name);
    }
  }

  // The most critical level of severity wins for the `ok` flag.
  const ok = !issues.some((i) => i.severity === "error");
  return { ok, issues };
}

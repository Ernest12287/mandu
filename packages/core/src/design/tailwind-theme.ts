/**
 * DESIGN.md → Tailwind v4 `@theme` compiler (Token Bridge).
 *
 * Issue #245 M3 — Team E. Reads structured tokens from a parsed
 * `DesignSpec` and emits the CSS `@theme` block Tailwind v4 inlines
 * to generate utility classes. The compiler is the **only** authoritative
 * source for the CSS variable names — Tailwind's naming convention is
 * baked in here so other tools (Guard, MCP) consult one place when
 * they need to map a token name to its `--var`.
 *
 * # Variable naming (Tailwind v4 convention)
 *
 *   - `--color-<name>`     — color palette
 *   - `--font-<name>`      — typography (font family)
 *   - `--text-<name>`      — typography (font size + line-height)
 *   - `--spacing-<scale>`  — layout / spacing
 *   - `--shadow-<name>`    — depth / elevation
 *
 * # Token name normalisation
 *
 * DESIGN.md author writes tokens in human form ("Hot Peach", "Body
 * Small"). Tailwind variables need kebab-case ASCII-safe identifiers.
 * `slugifyTokenName()` is the canonical normaliser:
 *
 *   "Hot Peach"   → "hot-peach"
 *   "Body Small"  → "body-small"
 *   "h1 hero"     → "h1-hero"
 *
 * Collisions (two tokens that slugify the same) are flagged as
 * `conflicts[]` so the caller can surface them — the compiler keeps
 * the first occurrence and skips duplicates.
 *
 * # Conflict detection
 *
 * `compileTailwindTheme` also emits warnings when a DESIGN.md token
 * contradicts an existing `@theme` block: same variable name, different
 * value. The merge step (`mergeThemeIntoCss`) preserves user-edited
 * regions outside the markers, so this is the only place the conflict
 * can be detected.
 */

import type { DesignSpec } from "./types";

// ─── Marker constants ────────────────────────────────────────────────

/**
 * Marker comments wrapping the auto-generated `@theme` body.
 *
 * Mandu only ever rewrites the region between these markers. Anything
 * outside is treated as user-owned and preserved verbatim. The marker
 * format is intentionally noisy so a casual reader can tell at a
 * glance "this is generated, don't hand-edit".
 */
export const THEME_MARKER_START = "/* @mandu-design-sync:start — generated from DESIGN.md, do not edit */";
export const THEME_MARKER_END = "/* @mandu-design-sync:end */";

// ─── Public surface ───────────────────────────────────────────────────

export interface CompiledThemeEntry {
  /** Tailwind v4 CSS variable name (`--color-primary`). */
  variable: string;
  value: string;
  /** Origin token from the DesignSpec (e.g. "Hot Peach"). */
  sourceTokenName: string;
  /** Section the token came from. */
  section: "color-palette" | "typography" | "layout" | "shadows";
}

export interface CompiledThemeWarning {
  kind: "missing-value" | "slug-collision";
  message: string;
  /** Token name as it appears in DESIGN.md. */
  tokenName: string;
  section: CompiledThemeEntry["section"];
}

export interface CompiledTheme {
  /** Flat list of variables in emit order. */
  entries: CompiledThemeEntry[];
  /** Non-fatal issues — missing values, slug collisions. */
  warnings: CompiledThemeWarning[];
  /** The `@theme { ... }` body as it would be written to disk. */
  cssBody: string;
}

export interface ThemeMergeConflict {
  variable: string;
  fromDesign: string;
  fromCss: string;
}

export interface ThemeMergeResult {
  /** Updated CSS — markered region replaced, rest preserved. */
  css: string;
  /**
   * Variables that collide with manual `@theme` declarations OUTSIDE
   * the marker region. The caller surfaces these in CLI output so the
   * user knows to reconcile.
   */
  conflicts: ThemeMergeConflict[];
  /** Whether the markered region already existed (vs. was inserted). */
  inserted: boolean;
}

/**
 * Compile a `DesignSpec` into a Tailwind v4 `@theme` block.
 *
 * Tokens with no parseable value are skipped with a `missing-value`
 * warning — they're declarative-only entries (e.g. "primary — see
 * docs"). Slug collisions also warn but never throw.
 */
export function compileTailwindTheme(spec: DesignSpec): CompiledTheme {
  const entries: CompiledThemeEntry[] = [];
  const warnings: CompiledThemeWarning[] = [];
  const seen = new Set<string>();

  // Color palette → --color-<slug>
  for (const token of spec.sections["color-palette"].tokens) {
    const variable = `--color-${slugifyTokenName(token.name)}`;
    if (!token.value) {
      warnings.push({
        kind: "missing-value",
        message: `color "${token.name}" has no parseable value — skipped`,
        tokenName: token.name,
        section: "color-palette",
      });
      continue;
    }
    if (seen.has(variable)) {
      warnings.push({
        kind: "slug-collision",
        message: `color "${token.name}" collides with an earlier token on ${variable} — skipped`,
        tokenName: token.name,
        section: "color-palette",
      });
      continue;
    }
    seen.add(variable);
    entries.push({
      variable,
      value: token.value,
      sourceTokenName: token.name,
      section: "color-palette",
    });
  }

  // Typography → --font-<slug> + --text-<slug>
  for (const token of spec.sections.typography.tokens) {
    const slug = slugifyTokenName(token.name);
    if (token.fontFamily) {
      const variable = `--font-${slug}`;
      if (!seen.has(variable)) {
        seen.add(variable);
        entries.push({
          variable,
          value: token.fontFamily,
          sourceTokenName: token.name,
          section: "typography",
        });
      } else {
        warnings.push({
          kind: "slug-collision",
          message: `typography "${token.name}" collides on ${variable}`,
          tokenName: token.name,
          section: "typography",
        });
      }
    }
    if (token.size) {
      const variable = `--text-${slug}`;
      const value = token.lineHeight ? `${token.size} / ${token.lineHeight}` : token.size;
      if (!seen.has(variable)) {
        seen.add(variable);
        entries.push({
          variable,
          value,
          sourceTokenName: token.name,
          section: "typography",
        });
      } else {
        warnings.push({
          kind: "slug-collision",
          message: `typography "${token.name}" collides on ${variable}`,
          tokenName: token.name,
          section: "typography",
        });
      }
    }
    if (!token.fontFamily && !token.size) {
      warnings.push({
        kind: "missing-value",
        message: `typography "${token.name}" has neither fontFamily nor size — skipped`,
        tokenName: token.name,
        section: "typography",
      });
    }
  }

  // Layout / spacing → --spacing-<slug>
  for (const token of spec.sections.layout.tokens) {
    if (!token.value) {
      warnings.push({
        kind: "missing-value",
        message: `spacing "${token.name}" has no value — skipped`,
        tokenName: token.name,
        section: "layout",
      });
      continue;
    }
    const variable = `--spacing-${slugifyTokenName(token.name)}`;
    if (seen.has(variable)) {
      warnings.push({
        kind: "slug-collision",
        message: `spacing "${token.name}" collides on ${variable}`,
        tokenName: token.name,
        section: "layout",
      });
      continue;
    }
    seen.add(variable);
    entries.push({
      variable,
      value: token.value,
      sourceTokenName: token.name,
      section: "layout",
    });
  }

  // Shadows → --shadow-<slug>
  for (const token of spec.sections.shadows.tokens) {
    if (!token.value) {
      warnings.push({
        kind: "missing-value",
        message: `shadow "${token.name}" has no value — skipped`,
        tokenName: token.name,
        section: "shadows",
      });
      continue;
    }
    const variable = `--shadow-${slugifyTokenName(token.name)}`;
    if (seen.has(variable)) {
      warnings.push({
        kind: "slug-collision",
        message: `shadow "${token.name}" collides on ${variable}`,
        tokenName: token.name,
        section: "shadows",
      });
      continue;
    }
    seen.add(variable);
    entries.push({
      variable,
      value: token.value,
      sourceTokenName: token.name,
      section: "shadows",
    });
  }

  return {
    entries,
    warnings,
    cssBody: formatThemeBody(entries),
  };
}

/**
 * Merge a compiled `@theme` body into an existing CSS file. The
 * markered region (between `THEME_MARKER_START` and `_END`) is
 * **replaced**; everything outside is preserved verbatim.
 *
 * If the markers are absent, the merger inserts a fresh markered block:
 *   - Inside the first existing `@theme { ... }` block when one exists
 *     (so users get to keep their hand-written palette and the
 *     generated block sits alongside it).
 *   - Otherwise as a top-level `@theme { ... }` block prepended to the
 *     file. The user can move it later — we err on the side of
 *     "visible at the top" rather than "buried somewhere".
 *
 * Conflicts: variables declared both inside the generated region AND
 * inside a hand-written `@theme` block elsewhere in the file are
 * surfaced in `conflicts[]`. The auto-generated value wins inside the
 * markered region; the user's value stays in their own block. The
 * caller decides what to do with the warning.
 */
export function mergeThemeIntoCss(
  existingCss: string,
  compiled: CompiledTheme,
): ThemeMergeResult {
  const generatedBlock = renderMarkeredBlock(compiled.cssBody);

  const startIdx = existingCss.indexOf(THEME_MARKER_START);
  const endIdx = existingCss.indexOf(THEME_MARKER_END);

  let merged: string;
  let inserted: boolean;
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existingCss.slice(0, startIdx);
    const after = existingCss.slice(endIdx + THEME_MARKER_END.length);
    merged = `${before}${generatedBlock}${after}`;
    inserted = false;
  } else {
    merged = insertMarkeredBlock(existingCss, generatedBlock);
    inserted = true;
  }

  const conflicts = detectMergeConflicts(existingCss, compiled);
  return { css: merged, conflicts, inserted };
}

/**
 * Strip the markered block from a CSS file — used by `mandu design
 * sync --remove` and tests.
 */
export function stripMarkeredBlock(css: string): string {
  const startIdx = css.indexOf(THEME_MARKER_START);
  const endIdx = css.indexOf(THEME_MARKER_END);
  if (startIdx < 0 || endIdx < startIdx) return css;
  const before = css.slice(0, startIdx).replace(/\n*$/, "\n");
  const after = css.slice(endIdx + THEME_MARKER_END.length).replace(/^\n+/, "");
  return `${before}${after}`;
}

/**
 * Slugify a human-friendly token name into a kebab-case ASCII slug
 * Tailwind v4 accepts as a CSS variable suffix.
 */
export function slugifyTokenName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

// ─── Internals ────────────────────────────────────────────────────────

function formatThemeBody(entries: CompiledThemeEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  let lastSection: CompiledThemeEntry["section"] | null = null;
  for (const entry of entries) {
    if (entry.section !== lastSection) {
      if (lastSection !== null) lines.push("");
      lines.push(`  /* ${humanizeSection(entry.section)} */`);
      lastSection = entry.section;
    }
    lines.push(`  ${entry.variable}: ${entry.value};`);
  }
  return lines.join("\n");
}

function humanizeSection(section: CompiledThemeEntry["section"]): string {
  switch (section) {
    case "color-palette":
      return "Colors";
    case "typography":
      return "Typography";
    case "layout":
      return "Spacing";
    case "shadows":
      return "Shadows";
  }
}

function renderMarkeredBlock(themeBody: string): string {
  if (themeBody.trim().length === 0) {
    // Even an empty body keeps the markers — re-running sync after
    // emptying DESIGN.md should remove old vars, not orphan them.
    return `${THEME_MARKER_START}\n@theme {\n}\n${THEME_MARKER_END}`;
  }
  return `${THEME_MARKER_START}\n@theme {\n${themeBody}\n}\n${THEME_MARKER_END}`;
}

/**
 * Insert a fresh markered block. Prefer to nest it inside an existing
 * `@theme` block when one exists; otherwise prepend.
 */
function insertMarkeredBlock(css: string, block: string): string {
  // Try to find the END of the first `@theme { ... }` block.
  const themeStart = /@theme\s*\{/.exec(css);
  if (themeStart) {
    let depth = 0;
    let i = themeStart.index;
    for (; i < css.length; i++) {
      const ch = css[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i < css.length) {
      // Insert just before the closing `}` of the existing @theme block,
      // unwrapping our generated block (which contains its own @theme).
      // The cleanest move: replace the whole existing @theme block with
      // a concatenation of "user's content" + generated body. But that
      // risks re-ordering. So instead, append the generated block AFTER
      // the existing one — Tailwind merges multiple @theme blocks at
      // build time.
      const before = css.slice(0, i + 1);
      const after = css.slice(i + 1);
      return `${before}\n\n${block}\n${after}`;
    }
  }
  // No existing @theme → prepend.
  return `${block}\n\n${css}`.replace(/\n{3,}/g, "\n\n");
}

function detectMergeConflicts(
  existingCss: string,
  compiled: CompiledTheme,
): ThemeMergeConflict[] {
  // Strip the markered region — anything inside is owned by Mandu and
  // can't conflict with itself.
  const outside = stripMarkeredBlock(existingCss);
  const conflicts: ThemeMergeConflict[] = [];
  for (const entry of compiled.entries) {
    const re = new RegExp(
      `${escapeRegex(entry.variable)}\\s*:\\s*([^;\\n]+);`,
      "m",
    );
    const m = re.exec(outside);
    if (!m) continue;
    const fromCss = m[1]!.trim();
    if (fromCss !== entry.value.trim()) {
      conflicts.push({
        variable: entry.variable,
        fromDesign: entry.value,
        fromCss,
      });
    }
  }
  return conflicts;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

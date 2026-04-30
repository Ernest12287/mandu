import type * as __ManduNodeFsTypes0 from "node:fs";
/**
 * DESIGN.md token extractor — scan project source for tokens that
 * should be promoted into DESIGN.md (Issue #245 M4 §3.5 internal loop).
 *
 * Scope:
 *   - **color**: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`,
 *     `hsl(...)`, `oklch(...)` literals in TS/TSX/JSX/CSS/MDX sources.
 *   - **font-family**: `font-family: "X", sans-serif` declarations and
 *     Tailwind v4-style `--font-<slug>: ...;` tokens that don't yet
 *     appear in DESIGN.md typography.
 *   - **component**: identifier-style className combos that recur 3+
 *     times across files, suggesting a missing extraction.
 *
 * The extractor is **proposal-only**: it never edits anything.
 * Callers (CLI / MCP `mandu.design.extract`) decide whether to flow
 * the proposals into DESIGN.md via `patchDesignMd`. Confidence is a
 * coarse 0..1 score driven by occurrence count; agents can filter on
 * it before showing the user.
 *
 * Performance: the walker bounds itself to the conventional source
 * roots and skips dotfile dirs / node_modules. Large monorepos can
 * narrow further with the `scope` option.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { DesignSpec } from "./types";

// ─── Public surface ───────────────────────────────────────────────────

export type ExtractKind = "color" | "typography" | "spacing" | "component";

export interface ExtractProposal {
  kind: ExtractKind;
  /** DESIGN.md section the proposal would land in. */
  section: "color-palette" | "typography" | "layout" | "components";
  /** Stable key to compare against existing tokens (slug or literal). */
  key: string;
  /** Suggested DESIGN.md value (`#FF8C42`, `Inter sans-serif`, …). */
  value: string;
  /** Total occurrences across the scanned tree. */
  occurrences: number;
  /** Up to 5 distinct file paths the literal/pattern was found in. */
  files: string[];
  /** Coarse 0..1 confidence — higher = more occurrences. */
  confidence: number;
  /** Optional human note ("seen in ButtonPrimary, ButtonGhost"). */
  note?: string;
}

export interface ExtractOptions {
  /** Glob-rooted scopes (relative). Defaults to `["src", "app"]`. */
  scope?: readonly string[];
  /** Filter the kinds emitted. Defaults to all four. */
  kinds?: readonly ExtractKind[];
  /** Minimum occurrence threshold for color/font/component. Default 3. */
  minOccurrences?: number;
  /**
   * When provided, proposals already represented by an existing
   * DesignSpec token are dropped (so agents only see "new" candidates).
   */
  existing?: DesignSpec;
}

export interface ExtractResult {
  proposals: ExtractProposal[];
  /** Total source files scanned. */
  scannedFiles: number;
}

/**
 * Walk the project and collect proposals. Pure async — no caching, no
 * side effects beyond reads.
 */
export async function extractDesignTokens(
  rootDir: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const scope = options.scope ?? ["src", "app"];
  const kinds = new Set<ExtractKind>(options.kinds ?? ["color", "typography", "spacing", "component"]);
  const minOccurrences = options.minOccurrences ?? 3;

  const colorOccurrences = new Map<string, { files: Set<string>; count: number }>();
  const fontFamilyOccurrences = new Map<string, { files: Set<string>; count: number }>();
  const classnameComboOccurrences = new Map<string, { files: Set<string>; count: number }>();

  let scannedFiles = 0;
  for (const dir of scope) {
    const root = path.join(rootDir, dir);
    const files = await collectFiles(root);
    scannedFiles += files.length;
    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(rootDir, file).replace(/\\/g, "/");
      if (kinds.has("color")) collectColors(content, rel, colorOccurrences);
      if (kinds.has("typography")) collectFontFamilies(content, rel, fontFamilyOccurrences);
      if (kinds.has("component")) collectClassNameCombos(content, rel, classnameComboOccurrences);
    }
  }

  const proposals: ExtractProposal[] = [];
  if (kinds.has("color")) {
    proposals.push(
      ...buildProposals({
        section: "color-palette",
        kind: "color",
        keyer: (literal) => literal,
        valuer: (literal) => literal,
        seed: colorOccurrences,
        minOccurrences,
        existingKeys: collectExistingColorValues(options.existing),
      }),
    );
  }
  if (kinds.has("typography")) {
    proposals.push(
      ...buildProposals({
        section: "typography",
        kind: "typography",
        keyer: (literal) => literal,
        valuer: (literal) => literal,
        seed: fontFamilyOccurrences,
        minOccurrences,
        existingKeys: collectExistingFontFamilies(options.existing),
      }),
    );
  }
  if (kinds.has("component")) {
    proposals.push(
      ...buildProposals({
        section: "components",
        kind: "component",
        keyer: (literal) => literal,
        valuer: (literal) => literal,
        seed: classnameComboOccurrences,
        minOccurrences,
        existingKeys: new Set(),
      }),
    );
  }

  proposals.sort((a, b) => b.occurrences - a.occurrences);
  return { proposals, scannedFiles };
}

// ─── Walker ───────────────────────────────────────────────────────────

const SOURCE_RX = /\.(?:tsx?|jsx?|mdx?|css)$/;

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: __ManduNodeFsTypes0.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile() && SOURCE_RX.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

// ─── Collectors ───────────────────────────────────────────────────────

const COLOR_RX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|(?:rgba?|hsla?|oklch|hwb|lab|lch)\([^)]+\)/g;

function collectColors(
  content: string,
  rel: string,
  bucket: Map<string, { files: Set<string>; count: number }>,
): void {
  let m: RegExpExecArray | null;
  while ((m = COLOR_RX.exec(content)) !== null) {
    const literal = m[0]!.toLowerCase();
    const entry = bucket.get(literal) ?? { files: new Set(), count: 0 };
    entry.files.add(rel);
    entry.count++;
    bucket.set(literal, entry);
  }
}

const FONT_FAMILY_RX = /font-family\s*:\s*([^;\n}]+)/gi;

function collectFontFamilies(
  content: string,
  rel: string,
  bucket: Map<string, { files: Set<string>; count: number }>,
): void {
  let m: RegExpExecArray | null;
  while ((m = FONT_FAMILY_RX.exec(content)) !== null) {
    const value = m[1]!.trim().replace(/[`'"]/g, "");
    if (!value || value.length > 200) continue;
    const entry = bucket.get(value) ?? { files: new Set(), count: 0 };
    entry.files.add(rel);
    entry.count++;
    bucket.set(value, entry);
  }
}

const CLASSNAME_RX = /className\s*=\s*["']([^"']{16,200})["']/g;

function collectClassNameCombos(
  content: string,
  rel: string,
  bucket: Map<string, { files: Set<string>; count: number }>,
): void {
  let m: RegExpExecArray | null;
  while ((m = CLASSNAME_RX.exec(content)) !== null) {
    const literal = m[1]!.trim().split(/\s+/).sort().join(" ");
    if (!literal) continue;
    // Skip combos that are mostly variant prefixes — they're rarely
    // good extraction candidates.
    const tokenCount = literal.split(/\s+/).length;
    if (tokenCount < 3) continue;
    const entry = bucket.get(literal) ?? { files: new Set(), count: 0 };
    entry.files.add(rel);
    entry.count++;
    bucket.set(literal, entry);
  }
}

// ─── Proposal builder ────────────────────────────────────────────────

interface BuildProposalsArgs {
  section: ExtractProposal["section"];
  kind: ExtractKind;
  keyer: (literal: string) => string;
  valuer: (literal: string) => string;
  seed: Map<string, { files: Set<string>; count: number }>;
  minOccurrences: number;
  existingKeys: Set<string>;
}

function buildProposals(args: BuildProposalsArgs): ExtractProposal[] {
  const out: ExtractProposal[] = [];
  for (const [literal, info] of args.seed) {
    if (info.count < args.minOccurrences) continue;
    const key = args.keyer(literal).toLowerCase();
    if (args.existingKeys.has(key)) continue;
    out.push({
      kind: args.kind,
      section: args.section,
      key: literal,
      value: args.valuer(literal),
      occurrences: info.count,
      files: [...info.files].slice(0, 5),
      confidence: Math.min(1, info.count / 10),
    });
  }
  return out;
}

function collectExistingColorValues(spec: DesignSpec | undefined): Set<string> {
  const out = new Set<string>();
  if (!spec) return out;
  for (const t of spec.sections["color-palette"].tokens) {
    if (t.value) out.add(t.value.toLowerCase());
  }
  return out;
}

function collectExistingFontFamilies(spec: DesignSpec | undefined): Set<string> {
  const out = new Set<string>();
  if (!spec) return out;
  for (const t of spec.sections.typography.tokens) {
    if (t.fontFamily) out.add(t.fontFamily.toLowerCase());
  }
  return out;
}

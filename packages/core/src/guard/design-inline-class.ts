/**
 * Guard rule — `DESIGN_INLINE_CLASS` (Issue #245).
 *
 * Scans `<rootDir>/src` and `<rootDir>/app` (whichever exist) for
 * `className` literals that contain a forbidden token, and emits a
 * Guard violation with the replacement-component hint.
 *
 * # Detection strategy
 *
 * Regex-based, intentionally not AST-based. The bundler and runtime
 * already pay AST cost; the Guard pass runs *frequently* (every
 * `mandu build` and every `mandu guard check`) and a regex sweep is
 * O(n) over file size with no parse failures. Tradeoff: a forbidden
 * token inside a *comment* will still flag — accepted as the lesser
 * evil vs. dragging in TypeScript parser overhead. False positives
 * are easy to silence with the `exclude` field; false negatives
 * (the regression we exist to prevent) are not.
 *
 * The matcher walks every quoted/backticked string region inside the
 * file content (`"..."`, `'...'`, `` `...` ``). For each region, it
 * tokenises by whitespace, normalises Tailwind-variant prefixes
 * (`hover:btn-hard` → `btn-hard`), and looks for any forbidden token.
 * Comments are not stripped — see tradeoff above.
 *
 * # Forbid-list sources
 *
 *   - `guard.design.forbidInlineClasses` — explicit list, always honoured.
 *   - `guard.design.autoFromDesignMd` — when true, also pull tokens
 *     from DESIGN.md §7 Do's & Don'ts. Each "don't" rule is scanned
 *     for a quoted token (`Inline \`btn-hard\`` → "btn-hard"); rules
 *     without an extractable token are skipped.
 *
 * # Exclude paths
 *
 * Glob-matched against the file's relative path. Defaults to
 * `src/client/shared/ui/**` and `src/client/widgets/**` so the rule
 * never flags the canonical component dirs themselves — those are
 * where the forbidden classes legitimately live.
 *
 * @module core/guard/design-inline-class
 */

import fs from "node:fs/promises";
import path from "node:path";

import { parseDesignMd } from "../design";
import type { GuardViolation } from "./rules";

// ────────────────────────────────────────────────────────────────────
// Config + types
// ────────────────────────────────────────────────────────────────────

export interface DesignGuardConfig {
  designMd?: string;
  forbidInlineClasses?: readonly string[];
  autoFromDesignMd?: boolean;
  requireComponent?: Readonly<Record<string, string>>;
  exclude?: readonly string[];
  severity?: "warning" | "error";
}

interface ResolvedConfig {
  forbid: Set<string>;
  requireComponent: Record<string, string>;
  exclude: string[];
  severity: "warning" | "error";
}

// ────────────────────────────────────────────────────────────────────
// File traversal
// ────────────────────────────────────────────────────────────────────

const SOURCE_EXTS = new Set([".tsx", ".ts", ".jsx", ".js"]);
const SCAN_ROOTS = ["src", "app"] as const;
const SKIP_DIRS = new Set([
  "node_modules",
  ".mandu",
  ".next",
  "dist",
  "build",
  ".git",
  ".turbo",
]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function* walk(rootDir: string): AsyncIterable<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Glob (minimal)
// ────────────────────────────────────────────────────────────────────

/**
 * Tiny glob matcher — `*` matches any character except `/`,
 * `**` matches any character including `/`. Supports the patterns
 * we actually emit as defaults; not a general-purpose minimatch.
 */
function globToRegExp(pattern: string): RegExp {
  // Normalize backslashes (Windows callers may pass them).
  const normalized = pattern.replace(/\\/g, "/");
  let rx = "";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        rx += ".*";
        i += 2;
        if (normalized[i] === "/") i += 1; // consume `/` after `**`
        continue;
      }
      rx += "[^/]*";
      i += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(c)) {
      rx += "\\" + c;
    } else if (c === "?") {
      rx += "[^/]";
    } else {
      rx += c;
    }
    i += 1;
  }
  return new RegExp(`^${rx}$`);
}

function isExcluded(relPath: string, patterns: readonly string[]): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  for (const pat of patterns) {
    if (globToRegExp(pat).test(normalized)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────
// String-region scanner
// ────────────────────────────────────────────────────────────────────

interface Hit {
  /** Forbidden class as configured. */
  token: string;
  /** 1-indexed line in the file. */
  line: number;
  /** 1-indexed column where the literal starts. */
  column: number;
  /** Original literal text (for the violation message). */
  literal: string;
}

const STRING_RX = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

/** Strip Tailwind variant prefixes (`hover:btn-hard` → `btn-hard`). */
function stripVariantPrefix(token: string): string {
  const lastColon = token.lastIndexOf(":");
  return lastColon >= 0 ? token.slice(lastColon + 1) : token;
}

function scanContent(content: string, forbid: Set<string>): Hit[] {
  if (forbid.size === 0) return [];
  const hits: Hit[] = [];
  // Pre-compute line index for fast line/column resolution.
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") lineStarts.push(i + 1);
  }
  function locate(offset: number): { line: number; column: number } {
    // Binary search on lineStarts.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    const line = hi + 1; // hi is the largest index with lineStarts[hi] <= offset
    const column = offset - lineStarts[hi] + 1;
    return { line, column };
  }

  let m: RegExpExecArray | null;
  while ((m = STRING_RX.exec(content)) !== null) {
    const literal = m[2];
    if (!literal) continue;
    // Tokenise by whitespace; classes inside template-literal `${...}`
    // expansions land in the surrounding text — close enough for
    // detection, false negatives only if the user dynamically computes
    // a forbidden class name (rare).
    for (const raw of literal.split(/\s+/)) {
      if (!raw) continue;
      const token = stripVariantPrefix(raw);
      if (forbid.has(token)) {
        const { line, column } = locate(m.index);
        hits.push({ token, line, column, literal });
      }
    }
  }
  return hits;
}

// ────────────────────────────────────────────────────────────────────
// DESIGN.md §7 Don't extractor (autoFromDesignMd)
// ────────────────────────────────────────────────────────────────────

const QUOTED_TOKEN_RX = /[`'"]([\w-]+)[`'"]/g;

function extractTokensFromDontRules(text: string): string[] {
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = QUOTED_TOKEN_RX.exec(text)) !== null) {
    if (m[1]) tokens.push(m[1]);
  }
  return tokens;
}

async function readDontRules(rootDir: string, designMdRel: string): Promise<string[]> {
  const designPath = path.join(rootDir, designMdRel);
  if (!(await pathExists(designPath))) return [];
  let source: string;
  try {
    source = await fs.readFile(designPath, "utf-8");
  } catch {
    return [];
  }
  const spec = parseDesignMd(source);
  const tokens = new Set<string>();
  for (const rule of spec.sections["dos-donts"].rules) {
    if (rule.kind !== "dont") continue;
    for (const t of extractTokensFromDontRules(rule.text)) {
      tokens.add(t);
    }
  }
  return [...tokens];
}

// ────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────

async function resolveConfig(
  rootDir: string,
  config: DesignGuardConfig,
): Promise<ResolvedConfig> {
  const forbid = new Set<string>(config.forbidInlineClasses ?? []);
  if (config.autoFromDesignMd === true) {
    const fromDesign = await readDontRules(rootDir, config.designMd ?? "DESIGN.md");
    for (const t of fromDesign) forbid.add(t);
  }
  return {
    forbid,
    requireComponent: { ...(config.requireComponent ?? {}) },
    exclude: [
      ...(config.exclude ?? [
        "src/client/shared/ui/**",
        "src/client/widgets/**",
      ]),
    ],
    severity: config.severity ?? "error",
  };
}

function buildMessage(
  hit: Hit,
  requireComponent: Record<string, string>,
): string {
  const replacement = requireComponent[hit.token];
  if (replacement) {
    return (
      `Forbidden inline class "${hit.token}" — use ${replacement} instead. ` +
      `(found in literal ${truncate(hit.literal, 60)})`
    );
  }
  return (
    `Forbidden inline class "${hit.token}" — see DESIGN.md §7 Do's & Don'ts ` +
    `or move to src/client/shared/ui / widgets.`
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return JSON.stringify(s);
  return JSON.stringify(s.slice(0, max - 1) + "…");
}

/**
 * Run the design-inline-class checker against the project source.
 * Returns Guard violations using the standard `GuardViolation` shape
 * so the existing reporter formats them uniformly.
 *
 * Skipped silently when `forbidInlineClasses` is empty AND
 * `autoFromDesignMd` is false (or DESIGN.md has no don't tokens).
 */
export async function checkDesignInlineClasses(
  rootDir: string,
  config: DesignGuardConfig | undefined,
): Promise<GuardViolation[]> {
  if (!config) return [];
  const resolved = await resolveConfig(rootDir, config);
  if (resolved.forbid.size === 0) return [];

  const violations: GuardViolation[] = [];
  for (const subdir of SCAN_ROOTS) {
    const root = path.join(rootDir, subdir);
    if (!(await pathExists(root))) continue;
    for await (const file of walk(root)) {
      const rel = path.relative(rootDir, file).replace(/\\/g, "/");
      if (isExcluded(rel, resolved.exclude)) continue;
      let content: string;
      try {
        content = await fs.readFile(file, "utf-8");
      } catch {
        continue;
      }
      const hits = scanContent(content, resolved.forbid);
      for (const hit of hits) {
        const replacement = resolved.requireComponent[hit.token];
        violations.push({
          ruleId: "DESIGN_INLINE_CLASS",
          file: rel,
          line: hit.line,
          message: buildMessage(hit, resolved.requireComponent),
          suggestion: replacement
            ? `Replace with ${replacement}.`
            : "Extract this class into a component under src/client/shared/ui/ or src/client/widgets/, or remove the inline usage.",
          severity: resolved.severity,
        });
      }
    }
  }
  return violations;
}

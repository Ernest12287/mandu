/**
 * Phase A.3 — exemplar scanner.
 *
 * Walks `.ts` / `.tsx` files in a directory tree and collects every
 * `@ate-exemplar:` / `@ate-exemplar-anti:` marker. Each marker is followed
 * by a test block (`test(...)`, `it(...)`, or `describe(...)` call) whose
 * entire source we capture for use as a few-shot example in composed prompts.
 *
 * Comment syntax (line comments):
 *
 *   // @ate-exemplar: kind=filling_unit depth=basic tags=post,formdata
 *   test("posts new todo", async () => { ... });
 *
 *   // @ate-exemplar-anti: kind=filling_unit reason="mocks DB"
 *   it("old fake", () => { ... });
 *
 * JSDoc-style block comments are ALSO supported:
 *
 *   /** @ate-exemplar: kind=filling_unit tags=happy-path *\/
 *   test("...", () => {});
 *
 * Parameters:
 *   kind   — required, matches a prompt kind (filling_unit, ...).
 *   depth  — optional, free-form tag the composer can use for selection.
 *   tags   — optional comma-separated list of free-form tags.
 *   reason — required for anti-exemplars.
 *
 * We use ts-morph (lazy-imported) to walk the AST so we can capture the
 * *entire* test-block text reliably — regex alone breaks on nested braces.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Exemplar {
  /** Repo-relative POSIX path. */
  path: string;
  /** 1-based line number of the exemplar comment. */
  startLine: number;
  /** 1-based line number of the closing `}` / `);` of the captured block. */
  endLine: number;
  kind: string;
  depth?: string;
  tags: string[];
  /** Full source of the captured test/describe/it call. */
  code: string;
  /** True for `@ate-exemplar-anti:` markers. */
  anti?: boolean;
  /** Required for anti markers — reason the pattern is wrong. */
  reason?: string;
}

export interface ScanOptions {
  /**
   * Glob-like directory filter — if provided, we only descend into paths
   * whose repo-relative string starts with one of these prefixes. This
   * keeps `scanExemplars(repoRoot)` from walking node_modules.
   */
  include?: string[];
  /** Extra ignore patterns on top of the defaults. */
  exclude?: string[];
}

const DEFAULT_EXCLUDE = [
  "node_modules",
  ".mandu",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
];

// ──────────────────────────────────────────────────────────────────────────
// Comment parsing
// ──────────────────────────────────────────────────────────────────────────

export interface ParsedMarker {
  anti: boolean;
  kind: string;
  depth?: string;
  tags: string[];
  reason?: string;
}

const MARKER_RE = /@ate-exemplar(-anti)?\s*:\s*([^\n\r*]*?)(?:\*\/|$)/;

/**
 * Is this line an actual source-code comment (vs. a string literal or JSDoc
 * example)? We require the marker text to be preceded (on the same line) by
 * either `//`, `/*`, or a leading `*` (inside a `/** ... *\/` block). The
 * JSDoc *example-snippet* case (e.g. `*   // @ate-exemplar: ...` nested
 * inside a doc block) is REJECTED — those are documentation, not real tags.
 */
/**
 * Returns true if the position at the end of `prefix` is inside an unclosed
 * single-quote, double-quote, or backtick string literal. Used to reject
 * markers that are arguments to function calls (test fixtures) rather than
 * real comments.
 */
function isInsideString(prefix: string): boolean {
  let single = false;
  let double = false;
  let backtick = false;
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (c === "\\") { i++; continue; }
    if (backtick) {
      if (c === "`") backtick = false;
      continue;
    }
    if (single) {
      if (c === "'") single = false;
      continue;
    }
    if (double) {
      if (c === '"') double = false;
      continue;
    }
    if (c === "'") single = true;
    else if (c === '"') double = true;
    else if (c === "`") backtick = true;
  }
  return single || double || backtick;
}

function isRealCommentMarker(line: string): boolean {
  const markerIdx = line.indexOf("@ate-exemplar");
  if (markerIdx < 0) return false;

  // Classify the comment context based on what appears before the marker on
  // this same line. We allow exactly three real-comment shapes:
  //   1. Line comment   — `// @ate-exemplar: ...` (before = ws + `//`)
  //   2. Block opener   — `/* @ate-exemplar: ... *\/` (must close on the same line)
  //   3. JSDoc opener   — `/** @ate-exemplar: ... *\/` (must close on the same line)
  //
  // Multi-line JSDoc example-snippets like `*   // @ate-exemplar: ...` nested
  // inside a `/** ... *\/` doc block are REJECTED — those are documentation.
  const before = line.slice(0, markerIdx);

  // Case 1: line comment.
  if (/\/\/\s*$/.test(before)) {
    // Reject when the // is itself preceded by ` *   ` — that's a JSDoc body
    // line showing an *example* of a line comment, not an actual line comment.
    if (/^\s*\*\s+.*\/\/\s*$/.test(before)) return false;
    // Reject when the `//` is INSIDE an open string literal — count quotes
    // before the marker; if the count is odd, we're inside a string.
    if (isInsideString(before)) return false;
    return true;
  }

  // Case 2 & 3: block/JSDoc on a single line (must self-close).
  if (/\/\*+\s*$/.test(before)) {
    return /\*\//.test(line.slice(markerIdx));
  }

  return false;
}

/**
 * Parse a single marker comment body like:
 *   `kind=filling_unit depth=basic tags=post,formdata`
 *   `kind=filling_unit reason="mocks DB"`
 *
 * Supports:
 *   - `key=value` with unquoted values (must not contain whitespace).
 *   - `key="value with spaces"` with double-quoted values.
 */
export function parseMarker(raw: string): ParsedMarker | null {
  if (!isRealCommentMarker(raw)) return null;
  const m = raw.match(MARKER_RE);
  if (!m) return null;
  const anti = Boolean(m[1]);
  const body = m[2].trim();

  const result: ParsedMarker = { anti, kind: "", tags: [] };
  // Tokenize respecting double quotes.
  const tokens: Array<[string, string]> = [];
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*("([^"]*)"|([^\s"]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const key = match[1];
    const val = match[3] !== undefined ? match[3] : match[4];
    tokens.push([key, val]);
  }

  for (const [key, val] of tokens) {
    switch (key) {
      case "kind":
        result.kind = val;
        break;
      case "depth":
        result.depth = val;
        break;
      case "tags":
        result.tags = val.split(",").map((t) => t.trim()).filter(Boolean);
        break;
      case "reason":
        result.reason = val;
        break;
      // Anything else is ignored — forwards-compat for new attrs.
    }
  }

  if (!result.kind) return null;
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// FS walk
// ──────────────────────────────────────────────────────────────────────────

function isTestSource(file: string): boolean {
  return file.endsWith(".ts") || file.endsWith(".tsx");
}

function* walkFiles(
  rootDir: string,
  currentRel: string,
  excludeSet: Set<string>
): Generator<string> {
  const abs = join(rootDir, currentRel);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return;
  }

  for (const name of entries) {
    if (excludeSet.has(name)) continue;
    const childRel = currentRel === "" ? name : `${currentRel}/${name}`;
    const childAbs = join(rootDir, childRel);
    let stat;
    try {
      stat = statSync(childAbs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkFiles(rootDir, childRel, excludeSet);
    } else if (stat.isFile() && isTestSource(name)) {
      yield childRel;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// AST-based block capture
//
// Given a ts-morph SourceFile and the line number of an `@ate-exemplar:`
// marker comment, find the nearest *following* CallExpression whose callee is
// `test` / `it` / `describe` / `test.describe`, and capture its entire
// text + span.
// ──────────────────────────────────────────────────────────────────────────

type TsMorphCallExpression = {
  getText(): string;
  getStartLineNumber(): number;
  getEndLineNumber(): number;
  getExpression(): { getText(): string };
};

type TsMorphSourceFile = {
  getDescendantsOfKind(kind: number): TsMorphCallExpression[];
};

type TsMorphProject = {
  createSourceFile(path: string, text: string, opts?: { overwrite?: boolean }): TsMorphSourceFile;
};

const CALL_EXPRESSION_KIND = 213; // ts.SyntaxKind.CallExpression (stable across TS 5.x)

const TEST_CALLEES = new Set([
  "test",
  "it",
  "describe",
  "test.describe",
  "test.skip",
  "test.only",
  "it.skip",
  "it.only",
  "describe.skip",
  "describe.only",
]);

function isTestCallee(expressionText: string): boolean {
  // Strip generic type args (e.g. `test<Foo>`).
  const noGen = expressionText.replace(/<[^>]*>$/, "");
  return TEST_CALLEES.has(noGen);
}

// ──────────────────────────────────────────────────────────────────────────
// Per-file scanning
// ──────────────────────────────────────────────────────────────────────────

function scanFile(
  absPath: string,
  repoRelPath: string,
  project: TsMorphProject
): Exemplar[] {
  let source: string;
  try {
    source = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }

  // Fast path: if the file contains no marker, skip ts-morph parse.
  if (!source.includes("@ate-exemplar")) return [];

  const lines = source.split(/\r?\n/);
  const markers: Array<{ line: number; marker: ParsedMarker }> = [];

  // Collect every marker (line-comments and block comments on a single line
  // are both handled because we scan line-by-line and the regex tolerates
  // both forms).
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("@ate-exemplar")) continue;
    const parsed = parseMarker(lines[i]);
    if (parsed) {
      markers.push({ line: i + 1, marker: parsed });
    }
  }

  if (markers.length === 0) return [];

  // Parse once via ts-morph to get reliable block spans.
  let sf: TsMorphSourceFile;
  try {
    sf = project.createSourceFile(absPath, source, { overwrite: true });
  } catch {
    // If the file doesn't parse (a malformed fixture, say), silently skip.
    return [];
  }

  const calls = sf.getDescendantsOfKind(CALL_EXPRESSION_KIND);
  const testCalls: TsMorphCallExpression[] = [];
  for (const c of calls) {
    try {
      if (isTestCallee(c.getExpression().getText())) {
        testCalls.push(c);
      }
    } catch {
      // If the expression can't be read (rare), skip.
    }
  }
  testCalls.sort((a, b) => a.getStartLineNumber() - b.getStartLineNumber());

  const exemplars: Exemplar[] = [];
  for (const { line, marker } of markers) {
    // Find the first test call that STARTS at or after the marker line.
    const hit = testCalls.find((tc) => tc.getStartLineNumber() >= line);
    if (!hit) {
      // No test block follows — it's an orphan marker. Skip here; the CLI
      // lint subcommand is the right layer to surface those as errors.
      continue;
    }

    const ex: Exemplar = {
      path: repoRelPath,
      startLine: line,
      endLine: hit.getEndLineNumber(),
      kind: marker.kind,
      tags: marker.tags,
      code: hit.getText(),
    };
    if (marker.depth) ex.depth = marker.depth;
    if (marker.anti) {
      ex.anti = true;
      if (marker.reason) ex.reason = marker.reason;
    }
    exemplars.push(ex);
  }

  return exemplars;
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Scan a directory tree for exemplar tags.
 *
 * Returns a flat list of {@link Exemplar} entries sorted by (path, startLine).
 */
export async function scanExemplars(
  rootDir: string,
  options: ScanOptions = {}
): Promise<Exemplar[]> {
  const exclude = new Set<string>([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]);

  // Lazy-load ts-morph — it's heavy.
  const { Project } = (await import("ts-morph")) as unknown as {
    Project: new () => TsMorphProject;
  };
  const project = new Project();

  const results: Exemplar[] = [];
  const roots = options.include && options.include.length > 0 ? options.include : [""];

  for (const root of roots) {
    for (const rel of walkFiles(rootDir, root, exclude)) {
      const abs = join(rootDir, rel);
      const repoRel = rel.split(sep).join("/");
      results.push(...scanFile(abs, repoRel, project));
    }
  }

  // Stable ordering so goldens don't flip.
  results.sort((a, b) => (a.path === b.path ? a.startLine - b.startLine : a.path.localeCompare(b.path)));
  return results;
}

/**
 * Synchronous scanner for a single file — used by the CLI lint command.
 * The caller supplies the ts-morph Project to avoid repeated imports.
 */
export function scanFileSync(
  absPath: string,
  repoRelPath: string,
  project: TsMorphProject
): Exemplar[] {
  return scanFile(absPath, repoRelPath, project);
}

/**
 * Light-weight scan that returns every `@ate-exemplar(-anti)?:` comment,
 * with NO AST capture. Useful for the `ate lint-exemplars` CLI which needs
 * to flag orphan markers (markers without a following test block).
 */
export interface MarkerSite {
  path: string;
  line: number;
  marker: ParsedMarker;
}

export async function scanMarkers(
  rootDir: string,
  options: ScanOptions = {}
): Promise<MarkerSite[]> {
  const exclude = new Set<string>([...DEFAULT_EXCLUDE, ...(options.exclude ?? [])]);
  const roots = options.include && options.include.length > 0 ? options.include : [""];
  const results: MarkerSite[] = [];

  for (const root of roots) {
    for (const rel of walkFiles(rootDir, root, exclude)) {
      const abs = join(rootDir, rel);
      let src: string;
      try {
        src = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (!src.includes("@ate-exemplar")) continue;
      const lines = src.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("@ate-exemplar")) continue;
        const m = parseMarker(lines[i]);
        if (m) {
          results.push({
            path: relative(rootDir, abs).split(sep).join("/"),
            line: i + 1,
            marker: m,
          });
        }
      }
    }
  }

  results.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
  return results;
}

/**
 * Loop Closure — Detectors
 *
 * Each detector is a **pure, deterministic** function of
 * `{ stdout, stderr, exitCode }` → Evidence[]. No filesystem, no spawn,
 * no network, no time-dependent behaviour.
 *
 * Detectors are regex-based heuristics, calibrated against real
 * `bun test` / `bun build` / `tsc` / Node output. They intentionally
 * err on the side of low false-positives — well-formed source code
 * from the Mandu tree must produce zero matches.
 *
 * Adding a new detector:
 *   1. Add a pure function conforming to `Detector`.
 *   2. Register it in `DEFAULT_DETECTORS`.
 *   3. Add a unit test in `__tests__/detectors.test.ts` with both
 *      a positive and a negative (real-source) case.
 */

import type {
  Detector,
  DetectorInput,
  DetectorRegistration,
  Evidence,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Safe one-line trim of a match snippet. */
function snip(raw: string, max = 200): string {
  const single = raw.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/** Concatenate stdout + stderr into a single stream with provenance markers. */
function _allLines(input: DetectorInput): string[] {
  const lines: string[] = [];
  if (input.stdout) lines.push(...input.stdout.split(/\r?\n/));
  if (input.stderr) lines.push(...input.stderr.split(/\r?\n/));
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────
// Individual detectors
// ─────────────────────────────────────────────────────────────────────────

/**
 * `TODO:` markers — source-style markers that surface in output
 * (e.g. compiler warnings, linter output, build logs).
 */
export const detectTodoMarkers: Detector = (input) => {
  const out: Evidence[] = [];
  const pattern = /\bTODO(?:\(([^)]*)\))?:\s*(.+)/g;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      out.push({
        kind: "todo-marker",
        snippet: snip(match[0]),
        label: match[1] ?? undefined,
      });
    }
  }
  return out;
};

/** `FIXME:` markers — siblings of TODO, flagged separately for clarity. */
export const detectFixmeMarkers: Detector = (input) => {
  const out: Evidence[] = [];
  const pattern = /\bFIXME(?:\(([^)]*)\))?:\s*(.+)/g;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      out.push({
        kind: "fixme-marker",
        snippet: snip(match[0]),
        label: match[1] ?? undefined,
      });
    }
  }
  return out;
};

/**
 * `throw new Error("not implemented")` and common synonyms in the output
 * — typically surfaces when a stub runs in anger.
 */
export const detectNotImplemented: Detector = (input) => {
  const out: Evidence[] = [];
  // Match error messages that surface the sentinel. We key off the thrown-text
  // to avoid matching docs/comments that merely describe "not implemented".
  const pattern =
    /(?:Error:\s*|throw\s+new\s+Error\s*\(\s*["'`])\s*(not\s+(?:yet\s+)?implemented|TODO(?:\s*:)?|unimplemented|NotImplementedError|Method not implemented)\s*["'`]?/gi;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      out.push({
        kind: "not-implemented",
        snippet: snip(match[0]),
        label: match[1],
      });
    }
  }
  return out;
};

/**
 * Unhandled promise rejection stack-trace banner. Node/Bun emit a stable
 * "Unhandled Promise Rejection", "UnhandledPromiseRejectionWarning", or
 * "unhandledRejection" header.
 *
 * Matching is case-sensitive and anchored on word boundaries so that
 * identifiers embedded in source code (e.g. `detectUnhandledRejection`)
 * do not trigger false positives.
 */
export const detectUnhandledRejection: Detector = (input) => {
  const out: Evidence[] = [];
  const patterns: RegExp[] = [
    // "Unhandled Promise Rejection" (with optional punctuation following)
    /\bUnhandled\s+Promise\s+Rejection\b[^\r\n]*/g,
    // "UnhandledPromiseRejectionWarning" (Node legacy banner — must be
    // preceded by non-word to avoid matching `myUnhandledPromiseRejectionWarning`)
    /(?<![A-Za-z0-9_$])UnhandledPromiseRejectionWarning\b[^\r\n]*/g,
    // Event name "unhandledRejection" — require preceding non-identifier
    // character so `detectUnhandledRejection` doesn't match.
    /(?<![A-Za-z0-9_$])unhandledRejection\b[^\r\n]*/g,
  ];
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        out.push({
          kind: "unhandled-rejection",
          snippet: snip(match[0]),
        });
      }
    }
  }
  return out;
};

/**
 * TypeScript compiler-style error lines: `path/to/file.ts(12,34): error TS2322: ...`
 * Also catches tsc's diagnostic banner `Found N errors`.
 */
export const detectTypecheckErrors: Detector = (input) => {
  const out: Evidence[] = [];
  const pattern =
    /([A-Za-z]:[\\/](?:[^:\n()]+)|\/[^:\n()]+|[^:\n()]+\.(?:ts|tsx|d\.ts))\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+?)(?=\r?\n|$)/g;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      out.push({
        kind: "typecheck-error",
        file: match[1],
        line: Number(match[2]),
        label: match[4],
        snippet: snip(`${match[4]}: ${match[5]}`),
      });
    }
  }
  return out;
};

/**
 * `bun test` failure marker: `(fail) <describe> > <it>` lines.
 *
 * Bun's default output prints `(fail)` for failures and `(pass)` for passes.
 * We match only `(fail)` so green output yields zero evidence.
 */
export const detectTestFailures: Detector = (input) => {
  const out: Evidence[] = [];
  const pattern = /\(fail\)\s+([^\r\n]+?)(?=\r?\n|$)/g;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      out.push({
        kind: "test-failure",
        snippet: snip(match[1]),
        label: match[1].trim(),
      });
    }
  }
  return out;
};

/**
 * "Cannot find module" / "Module not found" / "Could not resolve".
 * Covers Bun resolver, Node.js classic error, and bundler variants.
 */
export const detectMissingModule: Detector = (input) => {
  const out: Evidence[] = [];
  const patterns: RegExp[] = [
    /Cannot find module\s+["']([^"']+)["']/g,
    /Module not found[:\s]+["']?([^\s"'\r\n]+)["']?/g,
    /Could not resolve[:\s]+["']([^"']+)["']/g,
    /error:\s+Cannot resolve\s+["']([^"']+)["']/g,
  ];
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        out.push({
          kind: "missing-module",
          label: match[1],
          snippet: snip(match[0]),
        });
      }
    }
  }
  return out;
};

/**
 * Incomplete-function heuristic. We only flag very narrow, high-confidence
 * patterns so we never trip on legal code:
 *   - `function foo() {}` (empty body *on a single line*)
 *   - `=> { /* TODO *\/ }`-style arrows
 *
 * The heuristic runs against the **output stream**, not the source tree,
 * so only misbehavior that surfaces in logs is flagged.
 */
export const detectIncompleteFunction: Detector = (input) => {
  const out: Evidence[] = [];
  // Empty sync function declaration/expression, printed in a log:
  const empty = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*\}/g;
  // Arrow expression whose body is a single TODO comment:
  const arrowTodo = /\([^)]*\)\s*=>\s*\{\s*\/\/\s*TODO\b[^}]*\}/g;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const match of source.matchAll(empty)) {
      out.push({
        kind: "incomplete-function",
        label: match[1],
        snippet: snip(match[0]),
      });
    }
    for (const match of source.matchAll(arrowTodo)) {
      out.push({
        kind: "incomplete-function",
        snippet: snip(match[0]),
      });
    }
  }
  return out;
};

/**
 * Generic stack-trace line (`at fn (/path:line:col)`). Logged as secondary
 * evidence so the emitter can report *where* a crash happened even if no
 * other detector fires.
 */
export const detectStackTrace: Detector = (input) => {
  const out: Evidence[] = [];
  const pattern =
    /\bat\s+(?:[^\s(]+\s+)?\(?([A-Za-z]:[\\/][^:()\r\n]+|\/[^:()\r\n]+):(\d+):(\d+)\)?/g;
  // Stack traces only matter when something failed — gate on non-zero exit.
  if (input.exitCode === 0) return out;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    let n = 0;
    for (const match of source.matchAll(pattern)) {
      if (n >= 3) break; // cap evidence — keep the first few frames
      out.push({
        kind: "stack-trace",
        file: match[1],
        line: Number(match[2]),
        snippet: snip(match[0]),
      });
      n++;
    }
  }
  return out;
};

/**
 * `SyntaxError: ...` banner from a parser. Promotes to `syntax-error`
 * for unambiguous classification.
 */
export const detectSyntaxError: Detector = (input) => {
  const out: Evidence[] = [];
  const pattern = /\bSyntaxError:\s*([^\r\n]+)/g;
  for (const source of [input.stdout, input.stderr]) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      out.push({
        kind: "syntax-error",
        snippet: snip(match[0]),
        label: match[1],
      });
    }
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ordered list of default detectors. Order is priority-descending: the
 * first detector that returns any evidence determines `stallReason` when
 * multiple categories fire.
 */
export const DEFAULT_DETECTORS: readonly DetectorRegistration[] = Object.freeze([
  {
    id: "typecheck-error",
    description: "TypeScript compiler `path(line,col): error TSxxxx: ...` lines",
    run: detectTypecheckErrors,
  },
  {
    id: "test-failure",
    description: "Bun test `(fail) <name>` lines",
    run: detectTestFailures,
  },
  {
    id: "missing-module",
    description: "Module resolution errors from Bun/Node/bundlers",
    run: detectMissingModule,
  },
  {
    id: "syntax-error",
    description: "Parser `SyntaxError: ...` banners",
    run: detectSyntaxError,
  },
  {
    id: "not-implemented",
    description: "`throw new Error(\"not implemented\")` / NotImplementedError",
    run: detectNotImplemented,
  },
  {
    id: "unhandled-rejection",
    description: "Unhandled promise rejection warnings",
    run: detectUnhandledRejection,
  },
  {
    id: "incomplete-function",
    description: "Empty function bodies / TODO-only arrows in output",
    run: detectIncompleteFunction,
  },
  {
    id: "todo-marker",
    description: "`TODO:` markers in log output",
    run: detectTodoMarkers,
  },
  {
    id: "fixme-marker",
    description: "`FIXME:` markers in log output",
    run: detectFixmeMarkers,
  },
  {
    id: "stack-trace",
    description: "Stack-trace frames (gated on non-zero exit)",
    run: detectStackTrace,
  },
]);

/** Lookup helper for the emitter. */
export function listDetectorIds(): string[] {
  return DEFAULT_DETECTORS.map((d) => d.id);
}

/**
 * Run the selected detectors (or all by default) and return all evidence
 * in priority order.
 */
export function runDetectors(
  input: DetectorInput,
  only?: string[],
): Evidence[] {
  const allow = only ? new Set(only) : null;
  const results: Evidence[] = [];
  for (const det of DEFAULT_DETECTORS) {
    if (allow && !allow.has(det.id)) continue;
    const items = det.run(input);
    if (items.length > 0) results.push(...items);
  }
  return results;
}

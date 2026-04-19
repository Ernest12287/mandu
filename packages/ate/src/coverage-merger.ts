/**
 * LCOV merger — Phase 12.3
 *
 * Merges multiple LCOV v2 streams into a single canonical file. We need
 * this because `mandu test --coverage --e2e` produces two independent
 * coverage datasets:
 *
 *   1. `bun test --coverage` — unit/integration code coverage, LCOV
 *   2. `playwright test --coverage` — browser-side coverage, LCOV v2
 *
 * Merging is straightforward because LCOV is a line-oriented, per-file
 * record format. We sum `DA:` (line hit) counters, union `BRDA:` branch
 * and `FNDA:` function hit records, and recompute the trailing summary
 * lines (`LF`, `LH`, `BRF`, `BRH`, `FNF`, `FNH`).
 *
 * The canonical output is written to `.mandu/coverage/lcov.info` (spec
 * location per Phase 12.3). Downstream tooling (Codecov, Coveralls,
 * nyc-report) can consume the single file without being aware of its
 * provenance.
 *
 * ## LCOV v2 format (condensed)
 *
 * ```
 * TN:<test name>
 * SF:<source file>
 * FN:<line>,<name>
 * FNDA:<count>,<name>
 * FNF:<functions found>
 * FNH:<functions hit>
 * BRDA:<line>,<block>,<branch>,<count>
 * BRF:<branches found>
 * BRH:<branches hit>
 * DA:<line>,<count>[,<checksum>]
 * LF:<lines found>
 * LH:<lines hit>
 * end_of_record
 * ```
 *
 * Each `SF:` introduces a record that ends at `end_of_record`. Multiple
 * records may target the same source file — merging collapses them.
 */

import fs from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Per-file aggregate parsed from LCOV input(s). */
export interface LcovFileRecord {
  /** Source file (absolute or repo-relative). */
  sourceFile: string;
  /** Line → hit count (summed across inputs). */
  lineHits: Map<number, number>;
  /** Function declarations: name → line. */
  functions: Map<string, number>;
  /** Function hit counts: name → count (summed across inputs). */
  functionHits: Map<string, number>;
  /**
   * Branch hits keyed by `"<line>,<block>,<branch>"`.
   * Value is the summed count. `-` in the original stream maps to `0`.
   */
  branchHits: Map<string, number>;
  /** Optional test-name headers — preserved for debugging (joined with "|"). */
  testNames: Set<string>;
}

/** Result of merging several LCOV inputs into one. */
export interface MergeResult {
  /** Merged record map keyed by source file. */
  readonly records: Map<string, LcovFileRecord>;
  /** Rendered LCOV v2 text body. */
  readonly lcov: string;
  /** Counts summary — useful for CLI logs. */
  readonly summary: {
    readonly files: number;
    readonly linesFound: number;
    readonly linesHit: number;
    readonly branchesFound: number;
    readonly branchesHit: number;
    readonly functionsFound: number;
    readonly functionsHit: number;
  };
}

/** Input to `mergeLcovFiles` — paths OR raw LCOV text. */
export interface MergeInput {
  /** Human label for the input (e.g. "unit", "e2e"). Used in logs. */
  label: string;
  /** Either an absolute path to an LCOV file, or the LCOV body directly. */
  source: { kind: "file"; path: string } | { kind: "text"; body: string };
}

// ═══════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse an LCOV v2 body into per-file records. Unknown directives are
 * ignored (LCOV has many optional extensions — we only care about the
 * ones we need to re-emit).
 *
 * The parser is tolerant of blank lines, Windows line endings, and
 * trailing whitespace. `TN:` lines apply to the *next* `SF:` record only,
 * matching the genhtml convention.
 */
export function parseLcov(body: string): LcovFileRecord[] {
  const lines = body.split(/\r?\n/);
  const records: LcovFileRecord[] = [];

  let current: LcovFileRecord | null = null;
  let pendingTestName: string | null = null;

  const startRecord = (sourceFile: string): LcovFileRecord => {
    const existing = records.find((r) => r.sourceFile === sourceFile);
    if (existing) return existing;
    const rec: LcovFileRecord = {
      sourceFile,
      lineHits: new Map(),
      functions: new Map(),
      functionHits: new Map(),
      branchHits: new Map(),
      testNames: new Set(),
    };
    records.push(rec);
    return rec;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const colon = line.indexOf(":");
    const directive = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1);

    switch (directive) {
      case "TN": {
        pendingTestName = value;
        break;
      }
      case "SF": {
        current = startRecord(value);
        if (pendingTestName) current.testNames.add(pendingTestName);
        pendingTestName = null;
        break;
      }
      case "DA": {
        if (!current) break;
        // `DA:<line>,<count>[,<checksum>]`
        const parts = value.split(",");
        const lineNum = Number(parts[0]);
        const count = Number(parts[1]);
        if (Number.isFinite(lineNum) && Number.isFinite(count)) {
          const prev = current.lineHits.get(lineNum) ?? 0;
          current.lineHits.set(lineNum, prev + count);
        }
        break;
      }
      case "FN": {
        if (!current) break;
        // `FN:<line>,<name>`
        const comma = value.indexOf(",");
        if (comma === -1) break;
        const lineNum = Number(value.slice(0, comma));
        const name = value.slice(comma + 1);
        if (Number.isFinite(lineNum) && name) {
          current.functions.set(name, lineNum);
          if (!current.functionHits.has(name)) current.functionHits.set(name, 0);
        }
        break;
      }
      case "FNDA": {
        if (!current) break;
        // `FNDA:<count>,<name>`
        const comma = value.indexOf(",");
        if (comma === -1) break;
        const count = Number(value.slice(0, comma));
        const name = value.slice(comma + 1);
        if (Number.isFinite(count) && name) {
          const prev = current.functionHits.get(name) ?? 0;
          current.functionHits.set(name, prev + count);
        }
        break;
      }
      case "BRDA": {
        if (!current) break;
        // `BRDA:<line>,<block>,<branch>,<count-or-dash>`
        const parts = value.split(",");
        if (parts.length < 4) break;
        const key = `${parts[0]},${parts[1]},${parts[2]}`;
        const rawCount = parts[3];
        const count = rawCount === "-" ? 0 : Number(rawCount);
        if (Number.isFinite(count)) {
          const prev = current.branchHits.get(key) ?? 0;
          current.branchHits.set(key, prev + count);
        }
        break;
      }
      case "end_of_record": {
        current = null;
        break;
      }
      // Summary lines (LF/LH/BRF/BRH/FNF/FNH) are recomputed on output,
      // so we intentionally ignore them on input.
      default:
        break;
    }
  }

  return records;
}

// ═══════════════════════════════════════════════════════════════════════════
// Merge + serialize
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Merge two lists of records by source file. Maps are unioned; hit
 * counters are summed. The returned list preserves insertion order of
 * the first input (then appended with any new files from the second).
 */
export function mergeRecords(
  left: LcovFileRecord[],
  right: LcovFileRecord[],
): LcovFileRecord[] {
  const byFile = new Map<string, LcovFileRecord>();
  const ingest = (recs: LcovFileRecord[]): void => {
    for (const rec of recs) {
      const existing = byFile.get(rec.sourceFile);
      if (!existing) {
        // Clone so subsequent merges don't mutate the caller's data.
        byFile.set(rec.sourceFile, {
          sourceFile: rec.sourceFile,
          lineHits: new Map(rec.lineHits),
          functions: new Map(rec.functions),
          functionHits: new Map(rec.functionHits),
          branchHits: new Map(rec.branchHits),
          testNames: new Set(rec.testNames),
        });
        continue;
      }
      // Merge line hits
      for (const [lineNum, hits] of rec.lineHits) {
        existing.lineHits.set(lineNum, (existing.lineHits.get(lineNum) ?? 0) + hits);
      }
      // Merge function declarations (line numbers should match; last-wins OK)
      for (const [name, lineNum] of rec.functions) {
        existing.functions.set(name, lineNum);
      }
      // Merge function hits
      for (const [name, hits] of rec.functionHits) {
        existing.functionHits.set(name, (existing.functionHits.get(name) ?? 0) + hits);
      }
      // Merge branch hits
      for (const [key, hits] of rec.branchHits) {
        existing.branchHits.set(key, (existing.branchHits.get(key) ?? 0) + hits);
      }
      // Union test names
      for (const t of rec.testNames) existing.testNames.add(t);
    }
  };
  ingest(left);
  ingest(right);
  return Array.from(byFile.values());
}

function recordToLcov(rec: LcovFileRecord): string {
  const out: string[] = [];
  for (const tn of rec.testNames) out.push(`TN:${tn}`);
  out.push(`SF:${rec.sourceFile}`);

  // Functions — emit FN first, then FNDA, then FNF/FNH.
  const fnNames = Array.from(rec.functions.keys()).sort();
  for (const name of fnNames) {
    const lineNum = rec.functions.get(name);
    if (lineNum !== undefined) out.push(`FN:${lineNum},${name}`);
  }
  for (const name of fnNames) {
    const hits = rec.functionHits.get(name) ?? 0;
    out.push(`FNDA:${hits},${name}`);
  }
  const fnf = fnNames.length;
  const fnh = fnNames.filter((n) => (rec.functionHits.get(n) ?? 0) > 0).length;
  out.push(`FNF:${fnf}`);
  out.push(`FNH:${fnh}`);

  // Branches
  const brKeys = Array.from(rec.branchHits.keys()).sort((a, b) => {
    const [la, ba, xa] = a.split(",").map(Number);
    const [lb, bb, xb] = b.split(",").map(Number);
    if (la !== lb) return la - lb;
    if (ba !== bb) return ba - bb;
    return xa - xb;
  });
  for (const key of brKeys) {
    const count = rec.branchHits.get(key) ?? 0;
    out.push(`BRDA:${key},${count}`);
  }
  const brf = brKeys.length;
  const brh = brKeys.filter((k) => (rec.branchHits.get(k) ?? 0) > 0).length;
  out.push(`BRF:${brf}`);
  out.push(`BRH:${brh}`);

  // Line hits
  const lineNumbers = Array.from(rec.lineHits.keys()).sort((a, b) => a - b);
  for (const lineNum of lineNumbers) {
    const hits = rec.lineHits.get(lineNum) ?? 0;
    out.push(`DA:${lineNum},${hits}`);
  }
  const lf = lineNumbers.length;
  const lh = lineNumbers.filter((n) => (rec.lineHits.get(n) ?? 0) > 0).length;
  out.push(`LF:${lf}`);
  out.push(`LH:${lh}`);

  out.push("end_of_record");
  return out.join("\n");
}

/**
 * Render the merged records to a canonical LCOV v2 body. Records are
 * emitted in `sourceFile` lexicographic order so the output is byte-
 * stable across OS filesystems.
 */
export function serializeLcov(records: LcovFileRecord[]): string {
  const sorted = [...records].sort((a, b) =>
    a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0,
  );
  return sorted.map(recordToLcov).join("\n") + "\n";
}

/**
 * Compute an aggregate summary across all merged records.
 */
function computeSummary(records: LcovFileRecord[]): MergeResult["summary"] {
  let linesFound = 0;
  let linesHit = 0;
  let branchesFound = 0;
  let branchesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;

  for (const rec of records) {
    linesFound += rec.lineHits.size;
    for (const hits of rec.lineHits.values()) if (hits > 0) linesHit++;
    branchesFound += rec.branchHits.size;
    for (const hits of rec.branchHits.values()) if (hits > 0) branchesHit++;
    functionsFound += rec.functions.size;
    for (const name of rec.functions.keys()) {
      if ((rec.functionHits.get(name) ?? 0) > 0) functionsHit++;
    }
  }

  return {
    files: records.length,
    linesFound,
    linesHit,
    branchesFound,
    branchesHit,
    functionsFound,
    functionsHit,
  };
}

/**
 * End-to-end merge: reads every input (file or raw text), parses,
 * merges, and returns both the rendered LCOV body and a summary. Does
 * NOT write the output — callers decide the destination path so the
 * CLI can log it and tests can intercept.
 */
export function mergeLcovFiles(inputs: MergeInput[]): MergeResult {
  if (inputs.length === 0) {
    return {
      records: new Map(),
      lcov: "",
      summary: {
        files: 0,
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
      },
    };
  }

  let accumulator: LcovFileRecord[] = [];
  for (const input of inputs) {
    let body: string;
    if (input.source.kind === "file") {
      if (!fs.existsSync(input.source.path)) {
        // Missing input — skip silently so callers can attempt a merge
        // even when one of two coverage sources didn't emit (e.g. user
        // ran unit-only, but we wired the E2E merge step anyway).
        continue;
      }
      body = fs.readFileSync(input.source.path, "utf8");
    } else {
      body = input.source.body;
    }
    const parsed = parseLcov(body);
    accumulator = mergeRecords(accumulator, parsed);
  }

  const records = new Map<string, LcovFileRecord>();
  for (const rec of accumulator) records.set(rec.sourceFile, rec);

  return {
    records,
    lcov: serializeLcov(accumulator),
    summary: computeSummary(accumulator),
  };
}

/**
 * Write the merged LCOV body to disk (creating parent directories as
 * needed). Returns the absolute output path for logging.
 */
export function writeMergedLcov(outputPath: string, lcov: string): string {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, lcov, "utf8");
  return absolute;
}

/**
 * High-level convenience: merge a set of LCOV sources and write the
 * result to `.mandu/coverage/lcov.info` (or the supplied path).
 *
 * Returns a pair of `{ summary, outputPath }` — the caller's CLI is
 * expected to render the summary as human-readable stdout.
 */
export function mergeAndWriteLcov(params: {
  repoRoot: string;
  inputs: MergeInput[];
  outputPath?: string;
}): { readonly summary: MergeResult["summary"]; readonly outputPath: string | null } {
  const result = mergeLcovFiles(params.inputs);
  if (result.records.size === 0) {
    return { summary: result.summary, outputPath: null };
  }
  const target =
    params.outputPath ??
    path.join(params.repoRoot, ".mandu", "coverage", "lcov.info");
  const absolute = writeMergedLcov(target, result.lcov);
  return { summary: result.summary, outputPath: absolute };
}

/**
 * flake-detector — rolling pass/fail transition counter.
 *
 * Persists one JSONL record per run to `.mandu/ate-run-history.jsonl`.
 * Flake score is the ratio of *status transitions* over the last
 * `windowSize` runs for a given spec:
 *
 *   score(PPPFPFF, windowSize=7) =
 *     transitions = P→F (run 4), F→P (run 5), P→F (run 6) = 3
 *     denom = windowSize - 1 = 6
 *     score = 3 / 6 = 0.5   ← flaky
 *
 *   score(PPPPP)  = 0 / 4 = 0.0  ← stable pass
 *   score(FFFFF)  = 0 / 4 = 0.0  ← stable fail (broken, not flaky)
 *
 * Stability choice (score = 0 for pure fail) follows the §7 boost
 * decision: a spec that always fails is a *broken* test, not a
 * *flaky* one. Agents/CI reason about these two failure modes
 * differently.
 *
 * Auto-prune: the file is capped at 10,000 entries. Oldest entries
 * are dropped in-place whenever `appendRunHistory` observes the
 * current tail exceeding the cap after the new entry is written.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./fs";

function reverseCopy<T>(items: readonly T[]): T[] {
  const reversed: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    reversed.push(items[index] as T);
  }
  return reversed;
}

export interface RunHistoryEntry {
  specPath: string;
  runId: string;
  status: "pass" | "fail" | "skipped";
  durationMs: number;
  timestamp: string;
  graphVersion: string;
  /**
   * Optional failure kind (one of FAILURE_KINDS) — surfaced so agent
   * tooling can query for "give me the last 5 contract_mismatch
   * failures on `/api/signup`". Absent on pass / skip.
   */
  failureKind?: string;
}

export interface FlakeSummary {
  specPath: string;
  flakeScore: number;
  /** Last N entries for the spec, newest first. */
  lastRuns: Array<{
    runId: string;
    status: "pass" | "fail" | "skipped";
    timestamp: string;
    durationMs: number;
  }>;
  lastPassedAt: string | null;
}

const DEFAULT_HARD_CAP = 10_000;
/**
 * Only run the full-rewrite prune every N appends. Between prune
 * checks we permit the file to grow a little past HARD_CAP — this
 * trades a small amount of extra disk for O(1) amortized append
 * cost instead of O(n) per call.
 */
const PRUNE_EVERY = 100;

function hardCap(): number {
  const raw = process.env.MANDU_ATE_HISTORY_CAP;
  if (!raw) return DEFAULT_HARD_CAP;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HARD_CAP;
}

export function historyFilePath(repoRoot: string): string {
  return join(repoRoot, ".mandu", "ate-run-history.jsonl");
}

let appendCounter = 0;

/**
 * Append one run record, then occasionally prune to HARD_CAP. The
 * append itself is a single `appendFileSync` call (O(1) wrt file
 * size). Prune is amortized via `PRUNE_EVERY`.
 */
export function appendRunHistory(repoRoot: string, entry: RunHistoryEntry): void {
  const path = historyFilePath(repoRoot);
  ensureDir(join(repoRoot, ".mandu"));
  const line = `${JSON.stringify(entry)}\n`;
  appendFileSync(path, line, "utf8");
  appendCounter += 1;
  if (appendCounter >= PRUNE_EVERY) {
    appendCounter = 0;
    maybePrune(path);
  }
}

function maybePrune(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = content.split("\n").filter(Boolean);
  const cap = hardCap();
  if (lines.length <= cap) return;
  const kept = lines.slice(lines.length - cap);
  writeFileSync(path, `${kept.join("\n")}\n`, "utf8");
}

/**
 * Force an immediate prune to HARD_CAP. Exposed for tests and for
 * callers that need a deterministic end-of-run trim.
 */
export function pruneHistory(repoRoot: string): void {
  appendCounter = 0;
  maybePrune(historyFilePath(repoRoot));
}

/**
 * Read every run history entry (JSONL). Corrupted lines are skipped
 * silently — the log is a best-effort trail, not an authoritative
 * ledger. A caller that needs the raw text can read `historyFilePath`
 * directly.
 */
export function readRunHistory(repoRoot: string): RunHistoryEntry[] {
  const path = historyFilePath(repoRoot);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: RunHistoryEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RunHistoryEntry;
      if (
        typeof parsed.specPath === "string" &&
        typeof parsed.runId === "string" &&
        (parsed.status === "pass" || parsed.status === "fail" || parsed.status === "skipped")
      ) {
        out.push(parsed);
      }
    } catch {
      // skip — malformed line
    }
  }
  return out;
}

/**
 * Flake score for a single spec over the last `windowSize` runs.
 * Returns 0 when we have fewer than 2 runs (undefined / not flaky).
 */
export function computeFlakeScore(
  repoRoot: string,
  specPath: string,
  windowSize = 20,
): number {
  const runs = readRunHistory(repoRoot)
    .filter((r) => r.specPath === specPath && r.status !== "skipped")
    .slice(-Math.max(2, windowSize));

  if (runs.length < 2) return 0;
  let transitions = 0;
  for (let i = 1; i < runs.length; i += 1) {
    if (runs[i].status !== runs[i - 1].status) transitions += 1;
  }
  const denom = runs.length - 1;
  if (denom === 0) return 0;
  const score = transitions / denom;
  return Math.min(1, Math.max(0, score));
}

/**
 * ISO-8601 of the most recent pass, or null when no pass exists in
 * history.
 */
export function lastPassedAt(repoRoot: string, specPath: string): string | null {
  const runs = readRunHistory(repoRoot).filter(
    (r) => r.specPath === specPath && r.status === "pass",
  );
  if (runs.length === 0) return null;
  return runs[runs.length - 1].timestamp;
}

export interface FlakeQueryOptions {
  windowSize?: number;
  /** Only include specs whose flakeScore is >= this value. */
  minScore?: number;
}

/**
 * Aggregate flake info across every spec present in history. Used by
 * the `mandu_ate_flakes` MCP tool.
 */
export function summarizeFlakes(
  repoRoot: string,
  options: FlakeQueryOptions = {},
): FlakeSummary[] {
  const windowSize = options.windowSize ?? 20;
  const minScore = options.minScore ?? 0.1;
  const runs = readRunHistory(repoRoot);

  const bySpec = new Map<string, RunHistoryEntry[]>();
  for (const r of runs) {
    const arr = bySpec.get(r.specPath);
    if (arr) arr.push(r);
    else bySpec.set(r.specPath, [r]);
  }

  const summaries: FlakeSummary[] = [];
  for (const [specPath, entries] of bySpec) {
    const score = computeFlakeScore(repoRoot, specPath, windowSize);
    if (score < minScore) continue;
    const window = entries.slice(-windowSize);
    const lastPass = reverseCopy(entries).find((e) => e.status === "pass");
    summaries.push({
      specPath,
      flakeScore: score,
      lastRuns: reverseCopy(window)
        .map((e) => ({
          runId: e.runId,
          status: e.status,
          timestamp: e.timestamp,
          durationMs: e.durationMs,
        })),
      lastPassedAt: lastPass?.timestamp ?? null,
    });
  }

  summaries.sort((a, b) => b.flakeScore - a.flakeScore);
  return summaries;
}

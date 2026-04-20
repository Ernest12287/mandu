/**
 * Phase 18.φ — Bundle size budget.
 *
 * `ManduConfig.build.budget` declares bundle-size ceilings. The CLI
 * (`mandu build`) evaluates every post-bundled island + total against the
 * budget and either fails (`mode: 'error'`) or warns (`mode: 'warning'`,
 * default) when a limit is exceeded.
 *
 * ── Design ─────────────────────────────────────────────────────────────────
 *
 *   - Pure function. `evaluateBudget(report, budget)` is side-effect free:
 *     it consumes the analyzer {@link AnalyzeReport} (already has raw / gz
 *     bytes measured by Phase 18.η) and produces a {@link BudgetReport}.
 *     Serialization / exit-code selection is the CLI's job.
 *   - Zero runtime deps. The analyzer already uses `zlib` for real gzip
 *     sizing — we consume its output rather than recompressing.
 *   - Semi-reasonable default. When a user declares `build.budget: {}`
 *     (empty) they opt out of the default 250 KB gzip ceiling. When the
 *     whole field is omitted (the common case today) the CLI passes
 *     `undefined` and this module is never called — zero overhead.
 *   - Strict schema. See `config/validate.ts` → `BuildBudgetConfigSchema`.
 *
 * ── What this module deliberately does NOT do ──────────────────────────────
 *
 *   - No tree-shaking suggestions. (see analyzer.ts design doc.)
 *   - No historical delta. `mandu build --analyze` already emits
 *     `.mandu/analyze/report.json` which a separate job can diff.
 *   - No I/O. Everything is in-memory so tests don't need tmpdirs.
 */

import type { AnalyzeReport } from "./analyzer";

// ============================================================================
// Types
// ============================================================================

/**
 * User-declared budget (from `ManduConfig.build.budget`). Every field is
 * optional; omitting `mode` defaults to `'warning'` so a first-time user
 * isn't surprised by a failing build. An entirely empty object (`{}`) is
 * a valid opt-out signal — "I know about budgets, please don't apply the
 * default ceiling".
 */
export interface BundleBudget {
  /** Per-island raw-byte ceiling. */
  maxRawBytes?: number;
  /** Per-island gzip-byte ceiling. */
  maxGzBytes?: number;
  /** Project-wide raw-byte ceiling (sum of islands + shared). */
  maxTotalRawBytes?: number;
  /** Project-wide gzip-byte ceiling. */
  maxTotalGzBytes?: number;
  /**
   * Per-island override. Keys are route/island ids as they appear in
   * {@link AnalyzeReport.islands[].name}. A value of `{ raw: 0 }` /
   * `{ gz: 0 }` is valid — it pins the island to 0 bytes, useful for
   * "this island should never be generated" assertions.
   */
  perIsland?: Record<string, { raw?: number; gz?: number }>;
  /**
   * Enforcement mode.
   *   - `'warning'` (default): print issues, continue build.
   *   - `'error'`: print issues, exit non-zero.
   *
   * The CLI owns the exit-code decision; this module only surfaces
   * `mode` so reporters can colour-code output consistently.
   */
  mode?: "error" | "warning";
}

/**
 * Severity of a single budget comparison outcome. `within10` is the yellow
 * "approaching" band (≥90% of the limit) the HTML report uses to colour
 * bars amber. The CLI treats `within10` as a non-failing warning even
 * under `mode: 'error'` — the build only fails on `exceeded`.
 */
export type BudgetStatus = "within" | "within10" | "exceeded";

export interface BudgetIslandCheck {
  /** Island / route id. */
  name: string;
  /** Raw bytes measured by the analyzer. */
  raw: number;
  /** Gzip bytes measured by the analyzer. */
  gz: number;
  /** Active raw ceiling for this island (per-island override or global). `null` when no raw ceiling applies. */
  rawLimit: number | null;
  /** Active gzip ceiling. `null` when no gzip ceiling applies. */
  gzLimit: number | null;
  /** Status derived from the stricter of `rawStatus` / `gzStatus`. */
  status: BudgetStatus;
  /** Per-axis status. */
  rawStatus: BudgetStatus;
  gzStatus: BudgetStatus;
  /** True when a `perIsland[name]` entry overrode a global limit. */
  overridden: boolean;
}

export interface BudgetTotalCheck {
  raw: number;
  gz: number;
  rawLimit: number | null;
  gzLimit: number | null;
  status: BudgetStatus;
  rawStatus: BudgetStatus;
  gzStatus: BudgetStatus;
}

export interface BudgetReport {
  /** Resolved mode (`'warning'` when the user omitted the field). */
  mode: "error" | "warning";
  /** One entry per island in {@link AnalyzeReport.islands}, input order preserved. */
  islands: BudgetIslandCheck[];
  /** Project-wide totals (only populated when a `maxTotal*` limit exists). */
  total: BudgetTotalCheck | null;
  /** True when at least one island or the total exceeded its limit. */
  hasExceeded: boolean;
  /** Convenience: total islands counted. */
  islandCount: number;
  /** Convenience: islands strictly `within` limits. */
  withinCount: number;
  /** Convenience: islands flagged `within10`. */
  approachingCount: number;
  /** Convenience: islands flagged `exceeded`. */
  exceededCount: number;
}

// ============================================================================
// Defaults
// ============================================================================

/**
 * The "nothing set" default. Applied when the user passes `build.budget`
 * whose every ceiling field is `undefined` EXCEPT they also left
 * `perIsland` / `maxTotal*` off — effectively a literal `{}` or a
 * `{ mode: 'warning' }` with no thresholds. Chosen to roughly match the
 * Next.js `largePageDataBytes` soft-warning threshold (128 KB gz) paired
 * with Astro's "ship under 200 KB of JS" rule of thumb — 250 KB gives
 * app-shell + React-runtime + a handful of libraries breathing room
 * before the warning fires.
 *
 * Setting any explicit field (even `maxRawBytes: 99999999`) disables the
 * auto-default. This lets `build.budget: {}` be an explicit opt-out.
 *
 * Exported so docs generators, tests, and tooling can surface the exact
 * number without hard-coding.
 */
export const DEFAULT_BUDGET_MAX_GZ_BYTES = 250_000;

/**
 * Return `true` when every ceiling-bearing field is missing. We then
 * inject the {@link DEFAULT_BUDGET_MAX_GZ_BYTES} default. An empty object
 * (`{}`) counts as "all fields missing" — the caller passed a budget
 * block on purpose but left everything unset. We still apply the default
 * to honour the documented behaviour: "declaring a budget block (even
 * empty) turns on the default 250 KB gzip cap". Users opt out of the
 * default entirely by omitting the `build.budget` field.
 */
function hasNoCeilings(b: BundleBudget): boolean {
  return (
    b.maxRawBytes === undefined &&
    b.maxGzBytes === undefined &&
    b.maxTotalRawBytes === undefined &&
    b.maxTotalGzBytes === undefined &&
    (b.perIsland === undefined || Object.keys(b.perIsland).length === 0)
  );
}

/**
 * Produce the effective budget the evaluator uses after applying
 * defaults. Exported for tests and docs so the "what will actually be
 * enforced" answer is one call away.
 */
export function resolveBudget(input: BundleBudget | undefined): BundleBudget | null {
  if (!input) return null;
  const base: BundleBudget = { ...input };
  base.mode = input.mode ?? "warning";
  if (hasNoCeilings(base)) {
    base.maxGzBytes = DEFAULT_BUDGET_MAX_GZ_BYTES;
  }
  return base;
}

// ============================================================================
// Evaluation
// ============================================================================

/**
 * 10% of the limit is the yellow band. Pulled out so tests and the HTML
 * report can reference the same constant.
 */
export const APPROACHING_THRESHOLD_RATIO = 0.9;

function classify(size: number, limit: number | null): BudgetStatus {
  if (limit === null) return "within";
  if (size > limit) return "exceeded";
  if (size >= limit * APPROACHING_THRESHOLD_RATIO) return "within10";
  return "within";
}

/**
 * The "worst" status across two axes. `exceeded` wins over `within10`
 * wins over `within`. Used to derive an island's composite status from
 * its per-axis (raw, gz) results.
 */
function worstStatus(a: BudgetStatus, b: BudgetStatus): BudgetStatus {
  if (a === "exceeded" || b === "exceeded") return "exceeded";
  if (a === "within10" || b === "within10") return "within10";
  return "within";
}

/**
 * Compare `report` against `budget` and produce the decision record.
 *
 * `budget === undefined` → the caller opted out entirely; we return
 * `null` so the CLI can skip printing the budget section.
 */
export function evaluateBudget(
  report: AnalyzeReport,
  budget: BundleBudget | undefined
): BudgetReport | null {
  const resolved = resolveBudget(budget);
  if (resolved === null) return null;

  const perIsland = resolved.perIsland ?? {};
  const islands: BudgetIslandCheck[] = report.islands.map((is) => {
    const override = perIsland[is.name];
    const hasOverride = override !== undefined;
    // Per-island override replaces the global cap on the axis it sets.
    // When a user writes `perIsland: { home: { raw: 50_000 } }` we still
    // apply the global `maxGzBytes` to `home`'s gzip size — the override
    // is additive per-axis, not a full replacement. This matches user
    // intent: "tighten this one axis, leave the others under the global".
    const rawLimit =
      override?.raw !== undefined
        ? override.raw
        : resolved.maxRawBytes !== undefined
          ? resolved.maxRawBytes
          : null;
    const gzLimit =
      override?.gz !== undefined
        ? override.gz
        : resolved.maxGzBytes !== undefined
          ? resolved.maxGzBytes
          : null;
    const rawStatus = classify(is.totalRaw, rawLimit);
    const gzStatus = classify(is.totalGz, gzLimit);
    return {
      name: is.name,
      raw: is.totalRaw,
      gz: is.totalGz,
      rawLimit,
      gzLimit,
      status: worstStatus(rawStatus, gzStatus),
      rawStatus,
      gzStatus,
      overridden: hasOverride,
    };
  });

  // Total check — ONLY populated when at least one total ceiling exists.
  // We intentionally do not fall back on per-island aggregates; if the
  // user wants "every island < 200 KB AND the whole project < 2 MB",
  // they must say so explicitly.
  let total: BudgetTotalCheck | null = null;
  if (
    resolved.maxTotalRawBytes !== undefined ||
    resolved.maxTotalGzBytes !== undefined
  ) {
    const rawLimit = resolved.maxTotalRawBytes ?? null;
    const gzLimit = resolved.maxTotalGzBytes ?? null;
    const rawStatus = classify(report.summary.totalRaw, rawLimit);
    const gzStatus = classify(report.summary.totalGz, gzLimit);
    total = {
      raw: report.summary.totalRaw,
      gz: report.summary.totalGz,
      rawLimit,
      gzLimit,
      status: worstStatus(rawStatus, gzStatus),
      rawStatus,
      gzStatus,
    };
  }

  let withinCount = 0;
  let approachingCount = 0;
  let exceededCount = 0;
  for (const i of islands) {
    if (i.status === "exceeded") exceededCount++;
    else if (i.status === "within10") approachingCount++;
    else withinCount++;
  }

  const hasExceeded =
    exceededCount > 0 || (total !== null && total.status === "exceeded");

  return {
    mode: resolved.mode ?? "warning",
    islands,
    total,
    hasExceeded,
    islandCount: islands.length,
    withinCount,
    approachingCount,
    exceededCount,
  };
}

// ============================================================================
// Formatting helpers (CLI + HTML report consumers)
// ============================================================================

/**
 * Human-readable byte formatter. Kept local (tiny, no import cycle) so
 * this module stays self-contained. Mirrors `analyzer.fmtBytes` output
 * format for consistency in build logs.
 */
export function formatBudgetBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * ASCII breakdown table. Used by the CLI when `--no-budget` is NOT set
 * and at least one check is warning/exceeded. Pure — returns the
 * already-formatted multi-line string so tests can snapshot it.
 *
 * Example:
 *
 *   ┌─────────────┬──────────┬──────────┬─────────┬─────────┐
 *   │ island      │ raw      │ gz       │ raw lim │ gz lim  │
 *   ├─────────────┼──────────┼──────────┼─────────┼─────────┤
 *   │ home EXC    │ 512.0 KB │ 180.0 KB │ —       │ 50.0 KB │
 *   │ dashboard   │  12.3 KB │   4.1 KB │ —       │ 50.0 KB │
 *   └─────────────┴──────────┴──────────┴─────────┴─────────┘
 */
export function formatBudgetTable(report: BudgetReport): string {
  const rows: string[][] = [["island", "raw", "gz", "raw lim", "gz lim", "status"]];
  for (const i of report.islands) {
    rows.push([
      i.name + (i.overridden ? "*" : ""),
      formatBudgetBytes(i.raw),
      formatBudgetBytes(i.gz),
      i.rawLimit === null ? "—" : formatBudgetBytes(i.rawLimit),
      i.gzLimit === null ? "—" : formatBudgetBytes(i.gzLimit),
      statusLabel(i.status),
    ]);
  }
  if (report.total) {
    rows.push([
      "<total>",
      formatBudgetBytes(report.total.raw),
      formatBudgetBytes(report.total.gz),
      report.total.rawLimit === null ? "—" : formatBudgetBytes(report.total.rawLimit),
      report.total.gzLimit === null ? "—" : formatBudgetBytes(report.total.gzLimit),
      statusLabel(report.total.status),
    ]);
  }
  // Compute column widths.
  const widths = rows[0].map((_, c) =>
    Math.max(...rows.map((r) => r[c].length))
  );
  const line = (ch = " ") =>
    "│" + widths.map((w) => " " + ch.repeat(w) + " ").join("│") + "│";
  const divider = (left: string, mid: string, right: string, fill = "─") =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;

  const out: string[] = [];
  out.push(divider("┌", "┬", "┐"));
  out.push(
    "│" +
      rows[0]
        .map((cell, c) => " " + cell.padEnd(widths[c]) + " ")
        .join("│") +
      "│"
  );
  out.push(divider("├", "┼", "┤"));
  for (let r = 1; r < rows.length; r++) {
    out.push(
      "│" +
        rows[r]
          .map((cell, c) => " " + cell.padEnd(widths[c]) + " ")
          .join("│") +
        "│"
    );
  }
  out.push(divider("└", "┴", "┘"));
  // Suppress unused `line` var — kept for future ruled rows.
  void line;
  return out.join("\n");
}

function statusLabel(s: BudgetStatus): string {
  switch (s) {
    case "exceeded":
      return "EXCEEDED";
    case "within10":
      return "APPROACHING";
    case "within":
      return "OK";
  }
}

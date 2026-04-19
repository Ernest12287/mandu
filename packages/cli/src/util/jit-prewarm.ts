/**
 * Phase 7.3 A — JIT prewarm for `mandu dev`.
 *
 * # Problem
 *
 * `scripts/cli-bench.ts` Phase 7.2 F benchmarks (docs/bun/phase-7-2-benchmarks.md
 * §7.1) showed a consistent +41 ms gap between the first warm iteration and
 * steady-state (P95 38.9 ms vs 17.6 ms on SSR page reload). Root cause: Bun's
 * JIT tier compiles react / react-dom / react-dom/server the FIRST time the
 * SSR pipeline calls `getRenderToString()` — which is only ever triggered by
 * the first inbound page request, not by boot itself. So the user always
 * eats the tier-up cost on their very first edit.
 *
 * # Approach
 *
 * Fire off the imports immediately after boot-seed (`validateAndReport`)
 * settles. The Promise is NEVER awaited on the `dev()` critical path —
 * "ready in Nms" is still emitted as soon as `Bun.serve` listens. By the
 * time the user has opened their browser (~100-200 ms of UI latency) and
 * hit `?cmd+s` on their editor, the JIT has already seen the hot functions
 * and promoted them to the Baseline/DFG tier.
 *
 * The hot set targeted:
 *   - `react`                 — JSX runtime
 *   - `react-dom`             — hydration primitives
 *   - `react-dom/server`      — `renderToString` (dev uses string path
 *                               unless `config.server.streaming === true`).
 *   - `react-dom/server.browser` — `renderToReadableStream` (streaming path).
 *
 * # Non-goals
 *
 * - NOT a bundler prewarm: we're not asking Bun to rebuild vendor shims
 *   early. Tier 2 vendor cache (Phase 7.2 R1) already handles cold → warm
 *   shim rebuilds.
 * - NOT a compile-ahead: no AOT, no precomputation of React trees. Just
 *   pushing modules through Bun's module loader so the functions exist
 *   in memory when the first SSR call dereferences them.
 * - NOT an attempt to move to single-digit "ready in Nms" — we are paying
 *   the load cost in the background AFTER the server is listening. If the
 *   dev server receives an HTTP request before prewarm completes, the
 *   request still pays full tier-up; this is an optimization for the
 *   steady-state "edit → reload" loop, which is the loudest UX complaint.
 *
 * # Safety
 *
 * - `startJitPrewarm()` returns a Promise that NEVER rejects. Any import
 *   failure (e.g. react-dom/server unreachable in an edge env) is logged
 *   under `MANDU_PERF=1` as a warning and swallowed. Dev boot MUST NOT
 *   block on, or fail because of, prewarm.
 * - `import()` calls are unconditional but wrapped in individual
 *   `.catch()` handlers so one failing specifier doesn't short-circuit
 *   the others (e.g. projects without `react-dom/server.browser` still
 *   prewarm react + react-dom).
 * - The returned Promise is intentionally discarded in `dev.ts` (no
 *   `await`) so that even a stalled import cannot delay the ready log.
 */

import { mark, measure } from "@mandujs/core/perf";
import { HMR_PERF } from "@mandujs/core/perf/hmr-markers";

/**
 * Modules to pull into Bun's module loader early so JIT can see their
 * exports before the first SSR render. Ordered by expected hit weight:
 *   1. react (cheapest, used by EVERY SSR path)
 *   2. react-dom (hydration, small)
 *   3. react-dom/server (renderToString — used by non-streaming dev)
 *   4. react-dom/server.browser (renderToReadableStream — streaming opt-in)
 */
const PREWARM_SPECIFIERS = [
  "react",
  "react-dom",
  "react-dom/server",
  "react-dom/server.browser",
] as const;

export interface PrewarmResult {
  /** Wall-clock ms from `startJitPrewarm()` to all imports settled. */
  durationMs: number;
  /** Count of specifiers that resolved successfully. */
  loaded: number;
  /** Count of specifiers that failed to resolve (non-fatal). */
  failed: number;
  /** Optional: list of failure reasons for MANDU_PERF diagnostics. */
  errors: Array<{ specifier: string; message: string }>;
}

/**
 * Kick off SSR hot-module imports as a fire-and-forget background task.
 *
 * Contract:
 *   - Caller MUST NOT `await` the returned Promise on any critical-path
 *     boot step. Attach `.then(logPrewarmResult)` for observability only.
 *   - Promise resolves once ALL imports have settled (success OR failure).
 *     Never rejects — use `result.errors` to inspect failures.
 *   - Safe to call multiple times; Bun's module cache makes subsequent
 *     calls cheap (but still allocates the Promise array — prefer single
 *     call per process).
 */
export function startJitPrewarm(): Promise<PrewarmResult> {
  const perfEnabled = process.env.MANDU_PERF === "1";
  if (perfEnabled) mark(HMR_PERF.JIT_PREWARM);

  const t0 = Bun.nanoseconds();
  const errors: Array<{ specifier: string; message: string }> = [];

  // Per-specifier catch so one missing dep doesn't poison the others.
  // `react-dom/server.browser` is the most likely to be absent in unusual
  // setups; catching it individually lets the other three still prewarm.
  const promises = PREWARM_SPECIFIERS.map((spec) =>
    import(spec)
      .then(() => ({ spec, ok: true as const }))
      .catch((err: unknown) => {
        errors.push({
          specifier: spec,
          message: err instanceof Error ? err.message : String(err),
        });
        return { spec, ok: false as const };
      }),
  );

  return Promise.all(promises).then((results) => {
    const loaded = results.filter((r) => r.ok).length;
    const failed = results.length - loaded;
    const durationMs = (Bun.nanoseconds() - t0) / 1_000_000;

    if (perfEnabled) {
      // Use `measure` so the perf log line is consistent with other
      // boot markers. `measure` tolerates a missing `mark` (returns 0),
      // so even if MANDU_PERF was toggled mid-boot we won't throw.
      measure(HMR_PERF.JIT_PREWARM, HMR_PERF.JIT_PREWARM);
    }

    return { durationMs, loaded, failed, errors };
  });
}

/**
 * Optional: pretty-print prewarm result. Used by `dev.ts` only when
 * `MANDU_PERF=1` is set, so the steady-state dev output stays clean.
 */
export function logPrewarmResult(result: PrewarmResult): void {
  if (process.env.MANDU_PERF !== "1") return;
  const failSuffix =
    result.failed > 0
      ? ` (${result.failed} failed: ${result.errors
          .map((e) => e.specifier)
          .join(", ")})`
      : "";
  // Intentionally console.log, matching the rest of the perf module's
  // output channel contract (see packages/core/src/perf/index.ts header).
  console.log(
    `[perf] jit-prewarm settled: ${result.loaded}/${
      result.loaded + result.failed
    } in ${result.durationMs.toFixed(2)}ms${failSuffix}`,
  );
}

/**
 * @mandujs/core/scheduler
 *
 * Thin, production-minded wrapper around `Bun.cron` (Bun 1.3.12+). Adds four
 * things the native API doesn't give on its own:
 *
 *   1. **Overlap prevention** — a second tick that fires while the previous
 *      handler is still pending increments `skipCount` instead of running the
 *      body concurrently. Native `Bun.cron` documents the same guarantee but
 *      we also enforce it defensively and surface the skip count.
 *   2. **Per-tick timeout (soft)** — `timeoutMs` logs a warning and clears the
 *      in-flight flag so the *next* scheduled tick can run; it does NOT abort
 *      the current handler (Bun.cron has no cancellation primitive). The
 *      original handler keeps running; we just stop blocking future ticks on
 *      it. This is the best you can do against a hung job without killing the
 *      process.
 *   3. **Dev-mode skip** — jobs marked `skipInDev: true` are not registered
 *      when `NODE_ENV !== "production"`. They still appear in `status()` with
 *      zero counters so dashboards don't have to special-case them.
 *   4. **Graceful shutdown** — `stop()` prevents new ticks immediately and
 *      resolves once all in-flight handlers settle.
 *
 * Single-process assumption: there is NO distributed lock, NO persistent queue,
 * and NO cross-instance coordination. Running two processes with the same
 * `defineCron` config will fire each job on every process. Use a queue
 * (BullMQ, PG-boss, SQS) if you need exactly-once or multi-instance semantics.
 *
 * At-most-once on restart: if the process dies between ticks, the missed tick
 * is lost — `Bun.cron` computes "next fire" from the moment it starts, not
 * from a persisted schedule. Document this for any job whose absence matters.
 *
 * @example
 * ```ts
 * import { defineCron } from "@mandujs/core/scheduler";
 *
 * const jobs = defineCron({
 *   "clean:sessions": {
 *     schedule: "*\/15 * * * *",
 *     run: async () => { await db.exec("DELETE FROM sessions WHERE expires_at < now()"); },
 *     skipInDev: true,
 *   },
 *   "daily:report": {
 *     schedule: "0 3 * * *",
 *     run: async ({ scheduledAt }) => { await emailReport(scheduledAt); },
 *     timeoutMs: 5 * 60_000,
 *   },
 * });
 *
 * jobs.start();
 * // ...later, on shutdown:
 * await jobs.stop();
 * ```
 *
 * @module scheduler
 */

/** Context passed to each job handler. */
export interface CronContext {
  /** Job name (the key under which the job was registered). */
  name: string;
  /** The scheduled firing time (close to, but not exactly, now). */
  scheduledAt: Date;
}

/** Configuration for a single cron job. */
export interface CronJobConfig {
  /** Crontab expression. Examples: "*\/15 * * * *", "0 3 * * *", "@daily". */
  schedule: string;
  /** Job handler. May be async; return value is ignored. */
  run: (ctx: CronContext) => void | Promise<void>;
  /** Skip registration in dev mode (NODE_ENV !== "production"). Default: false. */
  skipInDev?: boolean;
  /**
   * Soft timeout in ms. On timeout, a warning is logged and the in-flight flag
   * clears so the next tick can run. The current handler is NOT aborted —
   * Bun.cron has no cancellation primitive. Default: unlimited.
   */
  timeoutMs?: number;
}

/** Observable status for a single job. */
export interface CronJobStatus {
  /** Epoch ms of the last completed run, or null if never run. */
  lastRunAt: number | null;
  /** Duration of the last completed run in ms, or null if never run. */
  lastDurationMs: number | null;
  /** True while a handler is executing. */
  inFlight: boolean;
  /** Number of handler invocations that reached completion (including errors). */
  runCount: number;
  /** Number of ticks dropped because the previous run had not finished. */
  skipCount: number;
  /** Number of handler invocations that threw. */
  errorCount: number;
}

/** Handle returned by {@link defineCron}. */
export interface CronRegistration {
  /** Schedule all non-dev-skipped jobs. Idempotent — calling twice is a no-op. */
  start(): void;
  /** Stop accepting new ticks and wait for any in-flight handler to finish. */
  stop(): Promise<void>;
  /** Snapshot per-job statistics. */
  status(): Record<string, CronJobStatus>;
}

/** Minimal shape of the thing `Bun.cron` returns. */
interface CronJobHandle {
  stop?: () => void | Promise<void>;
}

/**
 * Function shape used to register a cron schedule. Matches `Bun.cron` but kept
 * abstract so tests can inject a controllable fake.
 *
 * @internal
 */
export type CronScheduleFn = (
  schedule: string,
  handler: () => void | Promise<void>,
) => CronJobHandle | void;

interface BunCronGlobal {
  cron?: CronScheduleFn;
}

/**
 * Resolves `Bun.cron` at call time. Throws a clear, actionable error when the
 * runtime doesn't provide it — matches the `auth/password.ts` style.
 */
function getBunCron(): CronScheduleFn {
  const g = globalThis as unknown as { Bun?: BunCronGlobal };
  if (!g.Bun || typeof g.Bun.cron !== "function") {
    throw new Error(
      "[@mandujs/core/scheduler] Bun.cron is unavailable — this module requires the Bun runtime (>= 1.3.12).",
    );
  }
  return g.Bun.cron;
}

/** Per-job mutable runtime state. */
interface JobState {
  readonly name: string;
  readonly config: CronJobConfig;
  readonly skipped: boolean;
  handle: CronJobHandle | null;
  status: CronJobStatus;
  /** Resolves when the in-flight handler (if any) finishes. */
  inFlightSettle: Promise<void> | null;
}

/**
 * Registers a set of cron jobs. Returns a handle; does NOT auto-start —
 * call `.start()` from your server boot sequence.
 *
 * The public API. Internally dispatches to {@link _defineCronWith} passing
 * `Bun.cron` as the scheduler.
 */
export function defineCron(jobs: Record<string, CronJobConfig>): CronRegistration {
  // Probe lazily so `defineCron({})` with no entries can still be called in
  // environments without `Bun.cron`. When the user actually goes to `start()`,
  // the probe runs — matching `getBunPassword()` behaviour.
  return _defineCronWith(jobs, (schedule, handler) => getBunCron()(schedule, handler));
}

/**
 * Core constructor. Exposed for tests so they can inject a controllable fake
 * scheduler and drive ticks deterministically without touching real cron.
 *
 * @internal
 */
export function _defineCronWith(
  jobs: Record<string, CronJobConfig>,
  scheduleFn: CronScheduleFn,
): CronRegistration {
  const isProd =
    typeof process !== "undefined" && process.env?.NODE_ENV === "production";

  // Freeze the job set at definition time — no add/remove after construction.
  const names = Object.keys(jobs);
  const states: Map<string, JobState> = new Map();
  for (const name of names) {
    const config = jobs[name];
    const skipped = config.skipInDev === true && !isProd;
    states.set(name, {
      name,
      config,
      skipped,
      handle: null,
      status: {
        lastRunAt: null,
        lastDurationMs: null,
        inFlight: false,
        runCount: 0,
        skipCount: 0,
        errorCount: 0,
      },
      inFlightSettle: null,
    });
  }

  let started = false;
  let stopping = false;

  function makeTickHandler(state: JobState): () => Promise<void> {
    return async () => {
      // No new ticks once we've started stopping.
      if (stopping) return;

      // Overlap prevention: if the previous invocation is still running, skip.
      if (state.status.inFlight) {
        state.status.skipCount += 1;
        return;
      }

      state.status.inFlight = true;
      const startedAt = Date.now();

      const ctx: CronContext = {
        name: state.name,
        scheduledAt: new Date(startedAt),
      };

      // The promise that future ticks (and `stop()`) wait on. We capture it
      // in a variable so the `.finally()` can resolve the outer promise even
      // if `run()` itself throws synchronously.
      let settleResolve!: () => void;
      const settle = new Promise<void>((r) => {
        settleResolve = r;
      });
      state.inFlightSettle = settle;

      const runAndCount = (async () => {
        try {
          await state.config.run(ctx);
        } catch (error) {
          state.status.errorCount += 1;
          // Error isolation — never let a handler crash the process.
          console.error(
            `[scheduler] job ${state.name} failed:`,
            error,
          );
        }
      })();

      // Decide whether to wait for the handler or give up after timeout.
      const timeoutMs = state.config.timeoutMs;
      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutMarker = Symbol("timeout");
        const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timeoutMarker), timeoutMs);
        });

        const winner = await Promise.race([runAndCount.then(() => null), timeoutPromise]);

        if (winner === timeoutMarker) {
          // Handler is still running on its own. Log, clear inFlight so the
          // next tick can fire, but do NOT attempt to cancel — Bun.cron has
          // no cancellation and calling back into the handler would risk
          // double-execution.
          console.warn(
            `[scheduler] job ${state.name} exceeded timeoutMs=${timeoutMs} — future ticks may run while the previous handler is still executing.`,
          );
          state.status.runCount += 1;
          state.status.lastRunAt = Date.now();
          state.status.lastDurationMs = Date.now() - startedAt;
          state.status.inFlight = false;
          settleResolve();
          state.inFlightSettle = null;
          return;
        }

        // Handler finished first — clear the timeout to avoid a leaked timer.
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      } else {
        await runAndCount;
      }

      state.status.runCount += 1;
      state.status.lastRunAt = Date.now();
      state.status.lastDurationMs = Date.now() - startedAt;
      state.status.inFlight = false;
      settleResolve();
      state.inFlightSettle = null;
    };
  }

  function start(): void {
    if (started) return;
    started = true;
    stopping = false;
    for (const state of states.values()) {
      if (state.skipped) continue;
      const tick = makeTickHandler(state);
      const handle = scheduleFn(state.config.schedule, tick);
      state.handle = handle ?? null;
    }
  }

  async function stop(): Promise<void> {
    if (!started) return;
    stopping = true;
    // Tell each underlying cron to stop firing new ticks. Handles returned
    // from `Bun.cron` may be void (docs show `await Bun.cron.remove(name)` as
    // the alternate shape), so we defensively handle both.
    const stopPromises: Array<Promise<void>> = [];
    for (const state of states.values()) {
      if (state.handle && typeof state.handle.stop === "function") {
        const r = state.handle.stop();
        if (r && typeof (r as Promise<void>).then === "function") {
          stopPromises.push(r as Promise<void>);
        }
      }
      state.handle = null;
    }
    if (stopPromises.length > 0) {
      await Promise.allSettled(stopPromises);
    }
    // Wait for any in-flight handler to settle.
    const inflight: Array<Promise<void>> = [];
    for (const state of states.values()) {
      if (state.inFlightSettle) inflight.push(state.inFlightSettle);
    }
    if (inflight.length > 0) {
      await Promise.allSettled(inflight);
    }
    started = false;
  }

  function status(): Record<string, CronJobStatus> {
    const out: Record<string, CronJobStatus> = {};
    for (const [name, state] of states) {
      // Snapshot (shallow clone) so callers can't mutate internal state.
      out[name] = { ...state.status };
    }
    return out;
  }

  return { start, stop, status };
}

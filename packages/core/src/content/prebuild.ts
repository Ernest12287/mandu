/**
 * Content Prebuild Runner (Issue #196).
 *
 * # Purpose
 *
 * `mandu dev` manages routes, the bundler, and HMR — but it does NOT
 * auto-generate files under `content/` that derived scripts produce
 * (e.g. `scripts/prebuild-docs.ts` writes `content/docs-data.ts`,
 * `scripts/prebuild-seo.ts` writes `content/sitemap.xml`, …). Without
 * this module every project has to wire the chain by hand:
 *
 *     bun scripts/prebuild-docs.ts && bun scripts/prebuild-seo.ts && mandu dev
 *
 * — which is error-prone and fragile on Windows where `&&` chains misbehave
 * in some shells. Issue #196 asks us to move this into the CLI so `mandu dev`
 * alone is enough.
 *
 * # Contract
 *
 *   1. **Discovery**: walk `<rootDir>/scripts/` for any file matching
 *      `prebuild*.{ts,tsx,js,mjs}`. Sort lexicographically so
 *      `prebuild-1-xxx` always runs before `prebuild-2-yyy` when the user
 *      needs ordering control via filename prefix.
 *
 *   2. **Execution**: run each script in a fresh `bun` subprocess with
 *      `stdio: "inherit"` so prebuild logs flow through unchanged. Scripts
 *      run **sequentially** (the first one's exit must settle before the
 *      next starts) — parallel execution is tempting but most docs-style
 *      prebuilds write to the same output dir and race conditions would
 *      silently corrupt output files.
 *
 *   3. **Failure mode**: a non-zero exit from any script aborts the chain
 *      and surfaces `PrebuildError` to the caller. `mandu dev` decides
 *      whether to abort (prod) or log + continue (dev) based on caller
 *      flags — this module does not make that policy decision.
 *
 *      **Error surface (Issue #203)**: when a script exits non-zero we
 *      tail its stdout/stderr (last 10 lines of each) into the error
 *      message so the user can see WHY it failed without scrolling back
 *      through the terminal. When a spawn rejection is a real `Error`
 *      (e.g. `ENOENT`) we propagate its `message` and attach `cause` so
 *      `err.cause?.stack` is recoverable — fixing the "non-Error thrown"
 *      ghost stack traces reporters saw pre-#203.
 *
 *   4. **Timeout (Issue #203 — configurable)**: per-script wall-clock cap.
 *      Default is 2 minutes (matching `packages/mcp/src/util/runCommand.ts`
 *      #136). Override precedence, highest first:
 *
 *        a. `options.timeoutMs` (explicit caller arg)
 *        b. `MANDU_PREBUILD_TIMEOUT_MS` environment variable
 *        c. `ManduConfig.dev.prebuildTimeoutMs` (threaded through by the
 *           CLI in `packages/cli/src/commands/dev.ts`)
 *        d. Default: 120_000 ms
 *
 *      When the timer fires we throw `PrebuildTimeoutError` with the
 *      script path + limit so `error.message` alone carries enough info
 *      to let the user pick their override path without re-reading docs.
 *
 *   5. **No side-effects on empty discovery**: if no scripts are found,
 *      `runPrebuildScripts` returns `{ ran: 0 }` silently. This is the
 *      default for projects without a `content/` workflow, so importing
 *      this module into `dev.ts` must stay invisible to them.
 *
 * # Non-goals
 *
 *   - NOT a general task-runner. Scripts are pure one-shot generators —
 *     no daemon / watch / IPC semantics.
 *   - NOT content-layer integration. This module does not know about
 *     `defineContentConfig` or the `ContentLayer` class; it purely
 *     orchestrates `scripts/prebuild-*.ts`.
 *   - NOT a Bun-only primitive: we use `Bun.spawn` for the subprocess
 *     because it is cheaper than `node:child_process` and matches the
 *     rest of the codebase (see MEMORY "child_process.spawn → Bun.spawn
 *     교체"), but the module exports do not expose any Bun types on the
 *     public surface.
 */

import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Filename shapes we treat as prebuild scripts. Sorted by lexicographic
 * order after discovery so that `prebuild-01-foo.ts` reliably runs before
 * `prebuild-02-bar.ts` — the user's ordering knob.
 *
 * We include `.mjs` because some projects ship pre-compiled prebuild
 * scripts in ESM format for CI speed.
 */
const PREBUILD_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const PREBUILD_FILENAME_RE = /^prebuild[-_.a-zA-Z0-9]*\.(ts|tsx|js|mjs)$/;

/**
 * Default per-script timeout. Matches the MCP `runCommand()` convention
 * (#136). Exported so `@mandujs/core` consumers (validators, tests) can
 * reference the same constant instead of re-hardcoding `2 * 60 * 1000`.
 */
export const DEFAULT_PREBUILD_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Env var name for the runtime override. Checked inside
 * `resolvePrebuildTimeout` when the caller does not pass an explicit
 * `timeoutMs`. Invalid values (non-numeric, <= 0) are ignored with a
 * single stderr warning so a typo does not silently break the default.
 */
export const PREBUILD_TIMEOUT_ENV = "MANDU_PREBUILD_TIMEOUT_MS";

/**
 * Resolve the timeout to apply for a single prebuild script, with
 * precedence (highest first):
 *
 *   1. `explicit` argument — if the CLI or a test passes an explicit
 *      `timeoutMs`, we honour it verbatim (no env lookup). This keeps
 *      the injected-spawn unit tests deterministic.
 *   2. `MANDU_PREBUILD_TIMEOUT_MS` environment variable (runtime knob
 *      for ops — set once in CI / docker env without re-deploying code).
 *   3. `DEFAULT_PREBUILD_TIMEOUT_MS`.
 *
 * Separated from `runPrebuildScripts` so the CLI can log the resolved
 * value without re-implementing the lookup.
 */
export function resolvePrebuildTimeout(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) {
    return explicit;
  }
  const envRaw = process.env[PREBUILD_TIMEOUT_ENV];
  if (typeof envRaw === "string" && envRaw.length > 0) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    // Warn once per process — a typoed env var silently falling back to
    // the default is the kind of issue #203 was reported to fix.
    console.warn(
      `[Mandu prebuild] ignoring invalid ${PREBUILD_TIMEOUT_ENV}='${envRaw}' (expected positive number of milliseconds). Falling back to default ${DEFAULT_PREBUILD_TIMEOUT_MS}ms.`,
    );
  }
  return DEFAULT_PREBUILD_TIMEOUT_MS;
}

/**
 * Discover prebuild scripts under `<rootDir>/<scriptsDir>`.
 *
 * Returns absolute paths (forward-slash on Windows) sorted lexicographically.
 * Does NOT touch the filesystem beyond a single `readdir` — symlinks are
 * treated like regular files (followed by Node's default policy).
 *
 * Exported as a named function so the dev-autoprebuild test can exercise
 * discovery independently of execution.
 */
export function discoverPrebuildScripts(
  rootDir: string,
  scriptsDir = "scripts",
): string[] {
  const scriptsPath = path.resolve(rootDir, scriptsDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(scriptsPath);
  } catch {
    // No scripts/ directory — not an error, just an empty discovery.
    return [];
  }

  const matched: string[] = [];
  for (const name of entries) {
    if (!PREBUILD_FILENAME_RE.test(name)) continue;
    const ext = path.extname(name);
    if (!PREBUILD_EXTENSIONS.has(ext)) continue;
    // Full absolute path — forward-slash on Windows so the log output is
    // consistent with the rest of the dev logging (see `maskSlotPath` in
    // `packages/cli/src/commands/dev.ts` for the same normalization
    // pattern).
    const abs = path.join(scriptsPath, name).replace(/\\/g, "/");
    matched.push(abs);
  }
  matched.sort((a, b) => a.localeCompare(b));
  return matched;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Error thrown when a prebuild script exits non-zero or when we could not
 * complete the spawn (e.g. `bun` binary missing, ENOENT on the script
 * path). The `scriptPath` + `exitCode` fields are stable so callers can
 * decide recovery policy without string-matching the message.
 *
 * Issue #203: when wrapping an inner `Error`, we preserve the inner
 * `.message` (shown in the message) AND set `this.cause = err` so
 * runtimes that render `err.cause` get the full stack. Previously we
 * sometimes lost the inner error entirely, producing a useless
 * `"non-Error thrown"` surface.
 */
export class PrebuildError extends Error {
  readonly scriptPath: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Last ~10 lines of stdout captured from the child process, if any. */
  readonly stdoutTail?: string;
  /** Last ~10 lines of stderr captured from the child process, if any. */
  readonly stderrTail?: string;

  constructor(
    message: string,
    options: {
      scriptPath: string;
      exitCode: number | null;
      durationMs: number;
      cause?: unknown;
      stdoutTail?: string;
      stderrTail?: string;
    },
  ) {
    super(message);
    this.name = "PrebuildError";
    this.scriptPath = options.scriptPath;
    this.exitCode = options.exitCode;
    this.durationMs = options.durationMs;
    if (options.stdoutTail !== undefined) this.stdoutTail = options.stdoutTail;
    if (options.stderrTail !== undefined) this.stderrTail = options.stderrTail;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Error thrown specifically when the per-script wall-clock timer elapses
 * before the subprocess exits. Separate class (a subclass of
 * `PrebuildError`) so callers can pattern-match:
 *
 *     if (err instanceof PrebuildTimeoutError) { showTimeoutHint(); }
 *     else if (err instanceof PrebuildError)   { showGenericHint(); }
 *
 * Without the subclass they would have to grep the `.message` string,
 * which is the exact anti-pattern Issue #203 flagged.
 *
 * The message always ends with an actionable hint naming the three
 * override paths (config field, env var, CLI flag) so the user can pick
 * one without reading the docs.
 */
export class PrebuildTimeoutError extends PrebuildError {
  readonly timeoutMs: number;

  constructor(options: {
    scriptPath: string;
    timeoutMs: number;
    durationMs: number;
    stdoutTail?: string;
    stderrTail?: string;
  }) {
    const { scriptPath, timeoutMs, durationMs } = options;
    super(
      `PrebuildTimeoutError: ${scriptPath} exceeded ${timeoutMs}ms (set dev.prebuildTimeoutMs in mandu.config.ts or ${PREBUILD_TIMEOUT_ENV} env var to override).`,
      {
        scriptPath,
        exitCode: null,
        durationMs,
        stdoutTail: options.stdoutTail,
        stderrTail: options.stderrTail,
      },
    );
    this.name = "PrebuildTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface PrebuildRunnerOptions {
  /** Project root. Absolute path — we resolve scripts relative to this. */
  rootDir: string;
  /**
   * Relative scripts dir (default: `"scripts"`). Override for projects
   * that put generators in a non-standard location.
   */
  scriptsDir?: string;
  /**
   * Per-script wall-clock timeout in milliseconds. Precedence matches
   * `resolvePrebuildTimeout`: explicit arg > `MANDU_PREBUILD_TIMEOUT_MS`
   * > `DEFAULT_PREBUILD_TIMEOUT_MS` (120_000).
   *
   * The CLI threads `ManduConfig.dev.prebuildTimeoutMs` into this field
   * so end-users typically configure the timeout declaratively without
   * passing an arg to this API.
   */
  timeoutMs?: number;
  /**
   * Called once per discovered script, before the subprocess starts.
   * Useful for CLI progress logs. Not awaited.
   */
  onStart?: (scriptPath: string, index: number, total: number) => void;
  /**
   * Called once per script after the subprocess exits (success OR failure).
   * Always runs before the Promise resolves/rejects.
   */
  onFinish?: (result: {
    scriptPath: string;
    exitCode: number | null;
    durationMs: number;
  }) => void;
  /**
   * Injected spawn hook — overridable in tests so we do not have to
   * actually fork `bun`. Default uses `Bun.spawn` with `stdio: "inherit"`.
   *
   * Contract: returns a `{ exitCode, durationMs }`. May also return
   * `stdoutTail` / `stderrTail` strings (the default spawn does not —
   * it uses `stdio: "inherit"` so there is no captured output to tail).
   * The hook is responsible for the actual kill on timeout.
   */
  spawn?: SpawnHook;
}

export interface PrebuildResult {
  ran: number;
  scripts: Array<{
    scriptPath: string;
    exitCode: number | null;
    durationMs: number;
  }>;
}

/**
 * Spawn shim — kept as an interface so tests can inject a pure-in-memory
 * replacement without monkey-patching `globalThis.Bun`.
 *
 * The hook is expected to self-enforce `timeoutMs` by killing the child
 * when the timer fires, then throwing `PrebuildTimeoutError`. The
 * default spawn follows this pattern. Custom hooks that skip the kill
 * are responsible for any consequent zombie.
 */
export type SpawnHook = (args: {
  scriptPath: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<{
  exitCode: number | null;
  durationMs: number;
  stdoutTail?: string;
  stderrTail?: string;
}>;

/**
 * Default spawn hook: fork `bun <scriptPath>` with `stdio: "inherit"` so
 * the user sees prebuild logs on the terminal in real time.
 *
 * The `timeoutMs` guard kills the subprocess via SIGTERM (Unix) /
 * `proc.kill()` (which sends SIGKILL on Windows — Bun's cross-platform
 * `kill` API). We intentionally do not chain SIGTERM → SIGKILL because
 * prebuild scripts are short-lived generators: a hung one is a bug the
 * user should see as a timeout error, not a half-killed zombie.
 *
 * `env` is inherited but we strip the inherited `MANDU_PERF` flag so the
 * prebuild's own perf log output doesn't muddle the dev boot perf trace
 * — otherwise the user's "dev boot in Nms" numbers include every
 * prebuild step, which is misleading.
 *
 * Note: `stdio: "inherit"` means we cannot capture stdout/stderr to tail
 * into the error message. The captured-tail feature is exercised by
 * injected spawn hooks in the test suite and by any future
 * capture-mode hook callers may want to wire (e.g. CI log bundling).
 */
export const defaultSpawn: SpawnHook = async ({
  scriptPath,
  cwd,
  timeoutMs,
}) => {
  const start = performance.now();

  // Scrub MANDU_PERF so prebuild logs don't leak into `mandu dev` perf
  // traces. Everything else is inherited.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "MANDU_PERF") continue;
    if (typeof v === "string") env[k] = v;
  }

  // Feature-detect Bun.spawn so this module can be imported in Node test
  // contexts without crashing on module load. Tests that need Bun-less
  // execution use the `spawn` injection hook anyway.
  type BunLike = {
    spawn: (opts: {
      cmd: string[];
      cwd?: string;
      stdio?: readonly [unknown, unknown, unknown];
      env?: Record<string, string>;
    }) => {
      exited: Promise<number>;
      kill: (signal?: number | string) => void;
    };
  };
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (!bun) {
    throw new Error(
      "[Mandu prebuild] Bun.spawn is not available in this environment. " +
        "Inject a custom `spawn` hook via PrebuildRunnerOptions to run outside Bun.",
    );
  }

  const proc = bun.spawn({
    cmd: ["bun", scriptPath],
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env,
  });

  // Timeout guard. Bun.spawn's `exited` Promise never rejects; it resolves
  // with the exit code (or null on signal). So we race against a setTimeout
  // and kill the subprocess if the timer wins.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Ignore — child may already be gone.
    }
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;
    const durationMs = performance.now() - start;
    if (timedOut) {
      throw new PrebuildTimeoutError({
        scriptPath,
        timeoutMs,
        durationMs,
      });
    }
    return { exitCode, durationMs };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Coerce an unknown rejection into a stable Error shape.
 *
 * Issue #203 root cause: the original wrap path did
 *
 *     throw new Error("non-Error thrown: " + String(e));
 *
 * when `e` was, say, a plain string — which destroyed stack info and
 * yielded the "non-Error thrown" message the reporter saw. This helper
 * preserves whatever signal we can extract:
 *
 *   - `Error` instance → use `err.message`, attach as `cause`.
 *   - Non-Error (string / number / object)  → use `String(e)` as
 *     message prefix AND attach the raw value as `cause` so debug
 *     tooling can introspect it.
 *
 * Never produces the string "non-Error thrown" — that phrase was the
 * explicit regression beacon.
 */
function describeInner(err: unknown): { message: string; cause: unknown } {
  if (err instanceof Error) {
    // `.message` may still be empty (hand-thrown `new Error()`); fall
    // back to the class name so the user sees something.
    const message = err.message.length > 0 ? err.message : err.name;
    return { message, cause: err };
  }
  // Primitives / plain objects: coerce to string. We intentionally do NOT
  // use the phrase "non-Error thrown" (the Issue #203 regression beacon).
  let message: string;
  try {
    message = typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    message = String(err);
  }
  if (!message || message === "{}") message = String(err);
  return { message: message || "unknown spawn rejection", cause: err };
}

/**
 * Run every `scripts/prebuild-*.ts` in sequence. Resolves with a summary
 * of which scripts ran and how long each took. Rejects with
 * `PrebuildError` (or `PrebuildTimeoutError` specifically) on the first
 * failure — subsequent scripts are NOT run, matching the `&&` chain
 * semantics the user relied on before.
 *
 * @example
 * ```ts
 * await runPrebuildScripts({ rootDir: process.cwd() });
 * ```
 */
export async function runPrebuildScripts(
  options: PrebuildRunnerOptions,
): Promise<PrebuildResult> {
  const {
    rootDir,
    scriptsDir = "scripts",
    onStart,
    onFinish,
    spawn = defaultSpawn,
  } = options;

  // Resolve timeout with env-var awareness so both the CLI and direct
  // programmatic callers pick up `MANDU_PREBUILD_TIMEOUT_MS` without
  // plumbing.
  const timeoutMs = resolvePrebuildTimeout(options.timeoutMs);

  const scripts = discoverPrebuildScripts(rootDir, scriptsDir);
  if (scripts.length === 0) {
    return { ran: 0, scripts: [] };
  }

  const results: PrebuildResult["scripts"] = [];
  for (let i = 0; i < scripts.length; i++) {
    const scriptPath = scripts[i];
    onStart?.(scriptPath, i, scripts.length);

    let exitCode: number | null;
    let durationMs: number;
    let stdoutTail: string | undefined;
    let stderrTail: string | undefined;
    try {
      const res = await spawn({ scriptPath, cwd: rootDir, timeoutMs });
      exitCode = res.exitCode;
      durationMs = res.durationMs;
      stdoutTail = res.stdoutTail;
      stderrTail = res.stderrTail;
    } catch (err) {
      // Already a PrebuildError (typically PrebuildTimeoutError from the
      // default spawn): propagate as-is after notifying onFinish so the
      // caller's UI ticks the row off.
      if (err instanceof PrebuildError) {
        onFinish?.({
          scriptPath: err.scriptPath,
          exitCode: err.exitCode,
          durationMs: err.durationMs,
        });
        results.push({
          scriptPath: err.scriptPath,
          exitCode: err.exitCode,
          durationMs: err.durationMs,
        });
        throw err;
      }
      // Non-PrebuildError rejection — wrap in a way that preserves the
      // inner error's message + stack (Issue #203: previously this path
      // produced a "non-Error thrown" surface with no useful info).
      const { message, cause } = describeInner(err);
      throw new PrebuildError(
        `Prebuild script '${scriptPath}' failed: ${message}`,
        {
          scriptPath,
          exitCode: null,
          durationMs: 0,
          cause,
        },
      );
    }

    onFinish?.({ scriptPath, exitCode, durationMs });
    results.push({ scriptPath, exitCode, durationMs });

    if (exitCode !== 0) {
      // Include captured output tails in the error so logs are actionable
      // even after the dev server aborts and wipes the scrollback.
      const tailHint = formatTailHint({ stdoutTail, stderrTail });
      throw new PrebuildError(
        `Prebuild script '${scriptPath}' exited with code ${exitCode}. ` +
          `Subsequent prebuild scripts were not run.` +
          (tailHint ? `\n${tailHint}` : ""),
        { scriptPath, exitCode, durationMs, stdoutTail, stderrTail },
      );
    }
  }

  return { ran: results.length, scripts: results };
}

/**
 * Format the captured stdout/stderr tails into a human-readable multi-line
 * hint suffix for `PrebuildError.message`. Returns an empty string when
 * neither tail is present (the default spawn path) so we do not bloat the
 * message with "[stdout tail]\n(empty)" noise in the common case.
 */
function formatTailHint(args: {
  stdoutTail?: string;
  stderrTail?: string;
}): string {
  const lines: string[] = [];
  if (args.stderrTail && args.stderrTail.length > 0) {
    lines.push("--- stderr (last 10 lines) ---");
    lines.push(tailLines(args.stderrTail, 10));
  }
  if (args.stdoutTail && args.stdoutTail.length > 0) {
    lines.push("--- stdout (last 10 lines) ---");
    lines.push(tailLines(args.stdoutTail, 10));
  }
  return lines.join("\n");
}

/**
 * Keep only the last N lines of a string. Exported indirectly through
 * `PrebuildError.message` formatting so test assertions can recompute
 * the expected tail without importing this helper.
 */
function tailLines(text: string, n: number): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // Strip one trailing empty line (shell output convention) so we count
  // real lines only.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/**
 * Determine whether a project appears to use the content/prebuild workflow.
 * Used by `mandu dev` to decide whether to enable auto-prebuild by default:
 * projects without `content/` AND without `scripts/prebuild-*.ts` pay no
 * cost and see no behaviour change.
 *
 * Policy: auto-prebuild activates when EITHER
 *   (a) `<rootDir>/content/` exists (the convention for Astro-style
 *       content collections), OR
 *   (b) at least one `scripts/prebuild-*.ts` is discovered.
 *
 * Returns `false` in every other case so `mandu dev` stays a pure
 * pass-through for simple apps.
 */
export function shouldAutoPrebuild(rootDir: string, scriptsDir = "scripts"): boolean {
  const contentDir = path.resolve(rootDir, "content");
  try {
    const stat = fs.statSync(contentDir);
    if (stat.isDirectory()) return true;
  } catch {
    // No content/ — fall through to scripts check.
  }
  const scripts = discoverPrebuildScripts(rootDir, scriptsDir);
  return scripts.length > 0;
}

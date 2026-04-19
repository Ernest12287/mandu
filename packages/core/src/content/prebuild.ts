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
 *   4. **Timeout**: per-script 2-minute wall-clock cap, matching the
 *      policy established by `packages/mcp/src/util/runCommand.ts` (#136).
 *      Override via `options.timeoutMs` for unusual long-running seeds.
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
 * Error thrown when a prebuild script exits non-zero or times out. The
 * `scriptPath` + `exitCode` fields are stable so callers can decide
 * recovery policy without string-matching the message.
 */
export class PrebuildError extends Error {
  readonly scriptPath: string;
  readonly exitCode: number | null;
  readonly durationMs: number;

  constructor(
    message: string,
    options: {
      scriptPath: string;
      exitCode: number | null;
      durationMs: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "PrebuildError";
    this.scriptPath = options.scriptPath;
    this.exitCode = options.exitCode;
    this.durationMs = options.durationMs;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
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
   * Per-script wall-clock timeout in milliseconds. Default: 2 minutes,
   * matching the MCP `runCommand()` convention (#136).
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
   * Contract: returns a `{ exited }` with an `exited` Promise that
   * resolves to the exit code (null on signal / timeout kill). The hook
   * is responsible for the actual kill on timeout.
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
 */
export type SpawnHook = (args: {
  scriptPath: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<{ exitCode: number | null; durationMs: number }>;

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
      throw new PrebuildError(
        `Prebuild script '${scriptPath}' exceeded timeout (${timeoutMs}ms) and was killed.`,
        { scriptPath, exitCode: null, durationMs },
      );
    }
    return { exitCode, durationMs };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Run every `scripts/prebuild-*.ts` in sequence. Resolves with a summary
 * of which scripts ran and how long each took. Rejects with
 * `PrebuildError` on the first failure (subsequent scripts are NOT run,
 * matching the `&&` chain semantics the user relied on before).
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
    timeoutMs = 2 * 60 * 1000,
    onStart,
    onFinish,
    spawn = defaultSpawn,
  } = options;

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
    try {
      const res = await spawn({ scriptPath, cwd: rootDir, timeoutMs });
      exitCode = res.exitCode;
      durationMs = res.durationMs;
    } catch (err) {
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
        // Re-throw to abort the chain on failure.
        throw err;
      }
      // Non-PrebuildError rejection — wrap so callers only see one error shape.
      throw new PrebuildError(
        `Prebuild script '${scriptPath}' failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          scriptPath,
          exitCode: null,
          durationMs: 0,
          cause: err,
        },
      );
    }

    onFinish?.({ scriptPath, exitCode, durationMs });
    results.push({ scriptPath, exitCode, durationMs });

    if (exitCode !== 0) {
      throw new PrebuildError(
        `Prebuild script '${scriptPath}' exited with code ${exitCode}. ` +
          `Subsequent prebuild scripts were not run.`,
        { scriptPath, exitCode, durationMs },
      );
    }
  }

  return { ran: results.length, scripts: results };
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

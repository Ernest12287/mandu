/**
 * `mandu test` — Phase 12.1 integrated test runner.
 *
 * Subcommands:
 *   - `mandu test`                → unit + integration
 *   - `mandu test unit`           → unit tests only
 *   - `mandu test integration`    → integration tests only
 *   - `mandu test all`            → alias for `mandu test`
 *
 * Flags:
 *   - `--filter <pattern>`   forwards to `bun test --filter`
 *   - `--watch`              forwards to `bun test --watch`
 *   - `--coverage`           forwards to `bun test --coverage`
 *   - `--bail`               forwards to `bun test --bail`
 *   - `--update-snapshots`   forwards to `bun test --update-snapshots`
 *
 * Everything else (env, stdio) is pass-through. The runner simply
 * resolves the config-driven glob set, then invokes `bun test` with
 * the resolved file list — so any feature Bun test supports is
 * automatically supported here without a shim layer.
 *
 * See `packages/core/src/config/validate.ts` → `TestConfigSchema`
 * for the shape of the configurable `test` block.
 */

import { Glob } from "bun";
import path from "path";
import { loadManduConfig } from "@mandujs/core/config/mandu";
import {
  resolveTestConfig,
  type ValidatedTestConfig,
} from "@mandujs/core/config/validate";
import { theme } from "../terminal";
import { CLI_ERROR_CODES, printCLIError } from "../errors";

/** Supported subcommand target. `"all"` expands to unit + integration. */
export type TestTarget = "all" | "unit" | "integration";

/** Flags parsed out of the CLI options map. */
export interface TestOptions {
  /** Glob-sub filter forwarded to `bun test --filter`. */
  filter?: string;
  /** Enable watch mode via `bun test --watch`. */
  watch?: boolean;
  /** Emit coverage report via `bun test --coverage`. */
  coverage?: boolean;
  /** Stop on first failure (forwarded as `--bail`). */
  bail?: boolean;
  /** Regenerate snapshot files. */
  updateSnapshots?: boolean;
  /** Override the working directory — defaults to `process.cwd()`. */
  cwd?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve every file path matching any of the `include` patterns and *not*
 * matching any of the `exclude` patterns. Results are absolute, deduped,
 * and sorted for deterministic ordering.
 *
 * Uses Bun's native `Glob.scan` (no external deps). Patterns are
 * interpreted relative to `cwd`; absolute patterns are passed through
 * unchanged.
 */
export async function discoverTestFiles(
  cwd: string,
  include: readonly string[],
  exclude: readonly string[],
): Promise<string[]> {
  const seen = new Set<string>();

  for (const pattern of include) {
    // Bun's Glob does not support the `!pattern` negation form inline, so we
    // run exclusions as a post-filter pass. This mirrors the behavior of
    // fast-glob / picomatch users expect.
    const glob = new Glob(pattern);
    for await (const hit of glob.scan({ cwd, absolute: true, onlyFiles: true })) {
      // Normalize Windows backslashes so patterns compose predictably.
      seen.add(hit.split(path.sep).join("/"));
    }
  }

  const excludeGlobs = exclude.map((p) => new Glob(p));
  const results: string[] = [];
  for (const file of seen) {
    // `match` checks against the pattern without listing the filesystem.
    // Check both the absolute path and the cwd-relative path so exclusion
    // globs written as `node_modules/**` work regardless of how the include
    // pattern resolved.
    const relative = path.relative(cwd, file).split(path.sep).join("/");
    const excluded = excludeGlobs.some(
      (g) => g.match(file) || g.match(relative),
    );
    if (!excluded) results.push(file);
  }

  results.sort();
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Test runner
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the `bun test` argv for a resolved file set. Exported for unit tests
 * so we can assert flag composition without actually spawning a subprocess.
 */
export function buildBunTestArgs(
  files: readonly string[],
  opts: TestOptions,
  timeoutMs: number,
): string[] {
  const args = ["test"];
  if (opts.watch) args.push("--watch");
  if (opts.coverage) args.push("--coverage");
  if (opts.bail) args.push("--bail");
  if (opts.updateSnapshots) args.push("--update-snapshots");
  if (opts.filter) args.push("--filter", opts.filter);
  args.push("--timeout", String(timeoutMs));
  for (const f of files) args.push(f);
  return args;
}

/**
 * Spawn `bun test` with the resolved argv. Returns the exit code verbatim so
 * callers map non-zero to `false` (failed run) and zero to `true`.
 *
 * We use `Bun.spawn` over `node:child_process` for three reasons:
 *   - It's the project-wide convention (per Phase 1 memory: #139).
 *   - Stdio streams are plain WritableStream → cleaner to hook for CI.
 *   - `exitCode` is a promise awaited directly; no `.on("exit", ...)` dance.
 *
 * Exposed as a separate helper so the `testCommand` orchestrator stays small
 * and the spawn can be swapped under test.
 */
export async function spawnBunTest(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const proc = Bun.spawn(["bun", ...args], {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

/**
 * Resolve the configured glob set for a single `target`.
 * Isolated so a caller that wants to preview discovery ("will anything
 * match?") can do so without running the suite.
 */
export async function resolveTargetFiles(
  cwd: string,
  target: "unit" | "integration",
  config: ValidatedTestConfig,
): Promise<string[]> {
  const block = config[target];
  return discoverTestFiles(cwd, block.include, block.exclude);
}

/**
 * Run a single target end-to-end. Returns `true` on zero exit code.
 * Emits a `CLI_E060` (no match) or `CLI_E061` (non-zero exit) on failure.
 */
async function runTarget(
  target: "unit" | "integration",
  config: ValidatedTestConfig,
  opts: TestOptions,
  cwd: string,
): Promise<boolean> {
  const files = await resolveTargetFiles(cwd, target, config);
  if (files.length === 0) {
    printCLIError(CLI_ERROR_CODES.TEST_NO_MATCH, { target });
    return false;
  }

  console.log(
    `${theme.heading(`mandu test ${target}`)} ${theme.muted(`(${files.length} file${files.length === 1 ? "" : "s"})`)}`,
  );

  const args = buildBunTestArgs(files, opts, config[target].timeout);
  const exitCode = await spawnBunTest(args, cwd);

  if (exitCode !== 0) {
    printCLIError(CLI_ERROR_CODES.TEST_RUNNER_FAILED, {
      target,
      exitCode: String(exitCode),
    });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main CLI entry point. Resolves config, dispatches to the requested target,
 * and reports outcomes via the standard `theme.*` / `printCLIError` channels.
 *
 * Concurrent execution of unit + integration is intentionally sequential —
 * parallel Bun.spawn runs can interleave stdout, making CI logs unreadable.
 * Parallelism inside each `bun test` invocation is still in play.
 */
export async function testCommand(
  target: TestTarget,
  opts: TestOptions = {},
): Promise<boolean> {
  const cwd = opts.cwd ?? process.cwd();
  const rawConfig = await loadManduConfig(cwd);
  const config = resolveTestConfig(rawConfig.test);

  if (target !== "all" && target !== "unit" && target !== "integration") {
    printCLIError(CLI_ERROR_CODES.TEST_UNKNOWN_TARGET, { target });
    return false;
  }

  if (target === "unit") {
    return runTarget("unit", config, opts, cwd);
  }

  if (target === "integration") {
    return runTarget("integration", config, opts, cwd);
  }

  // target === "all": run unit first, then integration. Stop on first failure
  // when `--bail` is set so CI doesn't drown in unrelated stack traces; fall
  // through otherwise so users see the full report for both suites.
  const unitOk = await runTarget("unit", config, opts, cwd);
  if (!unitOk && opts.bail) return false;

  const integrationOk = await runTarget("integration", config, opts, cwd);
  return unitOk && integrationOk;
}

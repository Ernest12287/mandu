/**
 * `mandu test` — integrated test runner.
 *
 * ## Phase 12.1 — unit + integration (implemented):
 *   - `mandu test`                → unit + integration
 *   - `mandu test unit`           → unit tests only
 *   - `mandu test integration`    → integration tests only
 *   - `mandu test all`            → alias for `mandu test`
 *
 * ## Phase 12.2 — E2E via ATE wrap (this file):
 *   - `mandu test --e2e`          → invoke ATE E2E codegen + runner
 *   - `mandu test --e2e --heal`   → additionally run the heal loop
 *   - `mandu test --e2e --dry-run`→ print the plan, do not spawn
 *
 * ## Phase 12.3 — coverage + watch + snapshot (this file):
 *   - `mandu test --coverage`     → `bun test --coverage` + optional E2E LCOV
 *                                   merged into `.mandu/coverage/lcov.info`
 *   - `mandu test --watch`        → chokidar watch app/ src/ packages/
 *                                   and re-run affected tests on change
 *   - `mandu test --watch --dry-run` → print the watch plan, exit 0
 *
 * ## Flag matrix
 *
 * | Flag              | Purpose                                          |
 * | ----------------- | ------------------------------------------------ |
 * | `--filter <g>`    | forwarded to `bun test --filter`                 |
 * | `--coverage`      | bun coverage + E2E coverage + lcov merge        |
 * | `--bail`          | stop on first failure                            |
 * | `--update-snapshots` / `-u` | regenerate snapshot files              |
 * | `--watch`         | chokidar watch → re-run affected                 |
 * | `--e2e`           | run ATE E2E pipeline after unit/integration      |
 * | `--heal`          | run ATE heal loop after an E2E failure           |
 * | `--dry-run`       | print plan and exit 0 (only valid with --e2e/--watch) |
 *
 * Everything else (env, stdio) is pass-through. The runner simply
 * resolves the config-driven glob set, then invokes `bun test` with
 * the resolved file list — so any feature Bun test supports is
 * automatically supported here without a shim layer.
 *
 * See `packages/core/src/config/validate.ts` → `TestConfigSchema`
 * for the shape of the configurable `test` block.
 *
 * ## Exit codes (CTO contract — Agent E Phase 12.2/12.3)
 *
 * |  0 | pass (or dry-run)                                    |
 * |  1 | test failure (assertions failed)                     |
 * |  2 | infra failure (spawn error, timeout, unexpected)     |
 * |  3 | usage error (unknown subcommand / bad flags)         |
 * |  4 | config error (missing playwright, missing config)    |
 */

import { Glob } from "bun";
import path from "path";
import fs from "fs";
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
  /** Enable watch mode — re-run affected tests on file changes. */
  watch?: boolean;
  /** Emit coverage report via `bun test --coverage` + LCOV merge. */
  coverage?: boolean;
  /** Stop on first failure (forwarded as `--bail`). */
  bail?: boolean;
  /** Regenerate snapshot files. */
  updateSnapshots?: boolean;
  /** Override the working directory — defaults to `process.cwd()`. */
  cwd?: string;
  /** Phase 12.2 — enable the ATE E2E pipeline after unit/integration. */
  e2e?: boolean;
  /** Phase 12.2 — run the ATE heal loop on E2E failure (requires --e2e). */
  heal?: boolean;
  /**
   * Phase 12.2/12.3 — print the plan for --e2e / --watch and exit 0.
   * Does nothing for plain unit/integration mode.
   */
  dryRun?: boolean;
  /** Phase 12.2 — base URL Playwright connects to. */
  baseURL?: string;
  /** Phase 12.2 — CI mode (forwarded to Playwright). */
  ci?: boolean;
  /** Phase 12.2 — limit E2E to a subset of route ids. */
  onlyRoutes?: string[];
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
  // `--watch` is intentionally NOT forwarded here: our own watcher owns the
  // re-run loop, and `bun test --watch` would short-circuit the affected-
  // file mapping. See `runWatchMode()` below.
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
// Phase 12.2 — E2E (--e2e, --heal, --dry-run)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the ATE E2E pipeline for the current project.
 *
 * We delegate all heavy lifting to `@mandujs/ate`:
 *   1. `ateExtract` — build the interaction graph from `app/`.
 *   2. `ateGenerate` — emit Playwright specs into `tests/e2e/auto/`.
 *   3. `planE2ERun` — compose the Playwright argv.
 *   4. `runE2E` — spawn Playwright, surface exit code + lcov path.
 *   5. (Optional) `ateHeal` — inspect the latest run, emit suggestions.
 *
 * When `--dry-run` is passed we stop after step 3 and print the plan.
 */
export async function runE2EPipeline(opts: {
  cwd: string;
  dryRun: boolean;
  heal: boolean;
  coverage: boolean;
  baseURL?: string;
  ci?: boolean;
  onlyRoutes?: string[];
}): Promise<{ ok: boolean; lcovPath: string | null }> {
  const {
    buildE2EPlan,
    describeE2ECodegenPlan,
    planE2ERun,
    describeE2ERunPlan,
    runE2E,
    ateExtract,
    ateGenerate,
    ateHeal,
    findMissingPlaywright,
  } = await import("@mandujs/ate");

  // Step 1 — plan phase (works even without playwright installed).
  const codegenPlan = buildE2EPlan({
    repoRoot: opts.cwd,
    onlyRoutes: opts.onlyRoutes,
    oracleLevel: "L1",
  });
  const runPlan = planE2ERun({
    repoRoot: opts.cwd,
    baseURL: opts.baseURL,
    ci: opts.ci,
    coverage: opts.coverage,
    onlyRoutes: opts.onlyRoutes,
  });

  if (opts.dryRun) {
    console.log(theme.heading("mandu test --e2e --dry-run"));
    console.log(describeE2ECodegenPlan(codegenPlan));
    console.log("");
    console.log(describeE2ERunPlan(runPlan));
    if (opts.heal) {
      console.log("");
      console.log(theme.muted("(heal loop would run after the Playwright exit)"));
    }
    return { ok: true, lcovPath: runPlan.lcovPath };
  }

  // Step 2 — extract graph (non-fatal if app/ missing; ate emits its own warnings).
  try {
    await ateExtract({ repoRoot: opts.cwd });
  } catch (err: unknown) {
    console.error(
      theme.error(
        `ATE extract failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { ok: false, lcovPath: null };
  }

  // Step 3 — generate specs.
  try {
    await ateGenerate({
      repoRoot: opts.cwd,
      oracleLevel: "L1",
      onlyRoutes: opts.onlyRoutes,
    });
  } catch (err: unknown) {
    console.error(
      theme.error(
        `ATE generate failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { ok: false, lcovPath: null };
  }

  // Step 4 — detect missing playwright up front so the error is actionable.
  const missing = findMissingPlaywright(opts.cwd);
  if (missing) {
    printCLIError(CLI_ERROR_CODES.TEST_E2E_PLAYWRIGHT_MISSING);
    return { ok: false, lcovPath: null };
  }

  // Step 5 — spawn.
  const result = await runE2E({
    repoRoot: opts.cwd,
    baseURL: opts.baseURL,
    ci: opts.ci,
    coverage: opts.coverage,
    onlyRoutes: opts.onlyRoutes,
  });

  const ok = result.exitCode === 0;
  if (!ok && opts.heal) {
    // Step 6 — heal (best effort, never throws).
    try {
      const healOut = await ateHeal({ repoRoot: opts.cwd, runId: "latest" });
      console.log(theme.heading("mandu test --heal"));
      console.log(JSON.stringify(healOut, null, 2));
    } catch (err: unknown) {
      console.error(
        theme.error(
          `Heal loop errored (ignored): ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  return { ok, lcovPath: result.lcovPath };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 12.3 — coverage (LCOV merge)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * After a successful `--coverage` run we gather every LCOV source Bun or
 * Playwright emitted, merge them, and write the canonical output to
 * `.mandu/coverage/lcov.info`.
 *
 * Bun's default LCOV location is `coverage/lcov.info` (configurable via
 * `bunfig.toml`). Playwright's output path is controlled by our
 * `PW_COVERAGE_OUTPUT` env var (see `e2e-runner.ts`). Both may be absent
 * (the user ran only one dimension) — the merger tolerates missing inputs.
 */
export async function mergeCoverageOutputs(opts: {
  cwd: string;
  e2eLcov: string | null;
}): Promise<{ outputPath: string | null; files: number }> {
  const { mergeAndWriteLcov } = await import("@mandujs/ate");

  const inputs: Array<{
    label: string;
    source: { kind: "file"; path: string };
  }> = [];

  // Bun writes to <cwd>/coverage/lcov.info by default. We also accept
  // the .mandu/coverage/unit.lcov convention so users with a Bun config
  // pointing there do not need extra flags.
  const candidates = [
    path.join(opts.cwd, "coverage", "lcov.info"),
    path.join(opts.cwd, ".mandu", "coverage", "unit.lcov"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      inputs.push({ label: "unit", source: { kind: "file", path: c } });
      break;
    }
  }

  if (opts.e2eLcov && fs.existsSync(opts.e2eLcov)) {
    inputs.push({ label: "e2e", source: { kind: "file", path: opts.e2eLcov } });
  }

  const res = mergeAndWriteLcov({ repoRoot: opts.cwd, inputs });
  return { outputPath: res.outputPath, files: res.summary.files };
}

/**
 * Enforce coverage thresholds from `mandu.config.ts → test.coverage.lines`.
 * Parses the merged LCOV, computes LF/LH ratios, and emits CLI_E065 when
 * below target.
 *
 * Returns `true` when thresholds are met (or none configured).
 */
export function enforceCoverageThreshold(
  lcovPath: string,
  thresholdPct: number | undefined,
): boolean {
  if (!thresholdPct || thresholdPct <= 0) return true;
  if (!fs.existsSync(lcovPath)) return true;

  const body = fs.readFileSync(lcovPath, "utf8");
  let lf = 0;
  let lh = 0;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("LF:")) lf += Number(line.slice(3)) || 0;
    else if (line.startsWith("LH:")) lh += Number(line.slice(3)) || 0;
  }
  if (lf === 0) return true; // no data points; do not fail
  const actual = (lh / lf) * 100;
  if (actual + 1e-9 < thresholdPct) {
    printCLIError(CLI_ERROR_CODES.TEST_COVERAGE_THRESHOLD, {
      actual: actual.toFixed(2),
      expected: String(thresholdPct),
    });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 12.3 — Watch mode
// ═══════════════════════════════════════════════════════════════════════════

/** A plan describing what `--watch` will do. Used by --dry-run. */
export interface WatchPlan {
  readonly watchDirs: string[];
  readonly debounceMs: number;
  readonly targets: TestTarget[];
  readonly initialFileCount: number;
}

/**
 * Resolve the list of directories we will watch. We keep it minimal so
 * users don't see spurious re-runs for config changes: `app/`, `src/`,
 * and `packages/` cover nearly all Mandu project layouts.
 *
 * Missing directories are filtered out so the plan reflects reality.
 */
export function resolveWatchDirs(cwd: string): string[] {
  const candidates = ["app", "src", "packages"];
  return candidates
    .map((rel) => path.join(cwd, rel))
    .filter((abs) => {
      try {
        return fs.statSync(abs).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * Plan-only variant — computes what the watcher would do without
 * starting any file handle. Called from `--dry-run`.
 */
export async function planWatch(
  _opts: TestOptions,
  cwd: string,
  config: ValidatedTestConfig,
): Promise<WatchPlan> {
  const watchDirs = resolveWatchDirs(cwd);
  const unit = await resolveTargetFiles(cwd, "unit", config);
  const integration = await resolveTargetFiles(cwd, "integration", config);

  return {
    watchDirs,
    debounceMs: 200,
    targets: ["unit", "integration"],
    initialFileCount: unit.length + integration.length,
  };
}

/** Render the watch plan as a human-readable block. */
export function describeWatchPlan(plan: WatchPlan): string {
  const lines: string[] = [];
  lines.push("mandu test --watch plan");
  lines.push(`  debounce:    ${plan.debounceMs}ms`);
  lines.push(`  targets:     ${plan.targets.join(", ")}`);
  lines.push(`  test files:  ${plan.initialFileCount}`);
  lines.push(`  watch dirs:  ${plan.watchDirs.length}`);
  for (const d of plan.watchDirs) lines.push(`    - ${d}`);
  return lines.join("\n");
}

/**
 * Map a set of changed files to the test files that should re-run.
 *
 * We use two signals:
 *
 *  1. **Direct match**: the changed file IS a test file → run it.
 *  2. **Import match**: a source file (non-test) changed → run every
 *     test file that imports it (by relative module path substring).
 *
 * This is intentionally simpler than the ATE dep-graph (`ate/dep-graph`).
 * That graph costs ~500ms to build and requires ts-morph; for a
 * sub-second watch loop we use a cheap grep-equivalent. Users needing
 * full transitive impact can use `mandu test:watch` which wraps the
 * ATE pipeline.
 *
 * Exported for unit tests.
 */
export function computeAffectedTests(params: {
  changedFiles: readonly string[];
  testFiles: readonly string[];
  readFile?: (abs: string) => string;
}): string[] {
  const changed = params.changedFiles.map((f) => f.split(path.sep).join("/"));
  const tests = params.testFiles.map((f) => f.split(path.sep).join("/"));
  const read =
    params.readFile ?? ((abs: string) => fs.readFileSync(abs, "utf8"));

  const affected = new Set<string>();

  // 1. Direct test-file match.
  for (const c of changed) {
    if (tests.includes(c)) affected.add(c);
  }

  // 2. Import scan: for each non-test change, look for tests that
  //    reference the file by basename.
  const sourceChanges = changed.filter((c) => !tests.includes(c));
  if (sourceChanges.length === 0) return Array.from(affected).sort();

  // Reduce false positives: derive both the full basename and the
  // extension-stripped form so `import X from "./foo"` matches `foo.ts`.
  const needles = sourceChanges.map((c) => {
    const base = path.basename(c);
    const stem = base.replace(/\.[a-z]+$/i, "");
    return { base, stem, full: c };
  });

  for (const testAbs of tests) {
    let body = "";
    try {
      body = read(testAbs);
    } catch {
      continue;
    }
    for (const n of needles) {
      // Match the bare filename, the extension-stripped form, OR the full
      // absolute path (some generated tests embed absolute paths). Any of
      // these hits a re-run.
      if (
        body.includes(n.base) ||
        body.includes(n.stem) ||
        body.includes(n.full)
      ) {
        affected.add(testAbs);
        break;
      }
    }
  }

  return Array.from(affected).sort();
}

/**
 * Run the watch loop. Non-returning until SIGINT / SIGTERM. We rely on
 * chokidar (already a transitive dep via `@mandujs/core`) for reliable
 * cross-platform fs.watch.
 */
export async function runWatchMode(
  opts: TestOptions,
  cwd: string,
  config: ValidatedTestConfig,
): Promise<boolean> {
  const watchDirs = resolveWatchDirs(cwd);
  if (watchDirs.length === 0) {
    printCLIError(CLI_ERROR_CODES.TEST_WATCH_NO_WATCH_DIRS);
    return false;
  }

  // Lazy-load chokidar so --dry-run never requires it to be installed.
  const chokidarMod = await import("chokidar");
  const chokidar = chokidarMod.default ?? chokidarMod;

  const testFiles = [
    ...(await resolveTargetFiles(cwd, "unit", config)),
    ...(await resolveTargetFiles(cwd, "integration", config)),
  ];

  console.log(theme.heading(`mandu test --watch`));
  console.log(theme.muted(`Watching ${watchDirs.length} director${watchDirs.length === 1 ? "y" : "ies"} (debounce 200ms). Press Ctrl+C to stop.`));

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let queued = false;
  const DEBOUNCE = 200;

  const trigger = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      while (pending.size > 0) {
        const batch = Array.from(pending);
        pending.clear();
        queued = false;

        const affected = computeAffectedTests({
          changedFiles: batch,
          testFiles,
        });
        if (affected.length === 0) {
          console.log(theme.muted(`[watch] ${batch.length} change(s), no affected test`));
          if (!queued) break;
          continue;
        }

        console.log(
          theme.heading(`[watch] Re-running ${affected.length} affected test file(s)`),
        );
        for (const f of affected) console.log(theme.muted(`  - ${f}`));

        const args = buildBunTestArgs(affected, opts, config.unit.timeout);
        const code = await spawnBunTest(args, cwd);
        console.log(
          code === 0
            ? theme.success(`[watch] PASS`)
            : theme.error(`[watch] FAIL (exit ${code})`),
        );
        if (!queued) break;
      }
    } finally {
      running = false;
    }
  };

  const handle = (abs: string): void => {
    const norm = abs.split(path.sep).join("/");
    pending.add(norm);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void trigger();
    }, DEBOUNCE);
  };

  const watcher = chokidar.watch(watchDirs, {
    ignoreInitial: true,
    ignored: [
      /node_modules/,
      /\.git/,
      /\.mandu/,
      /dist/,
      // Respect user's .gitignore by piggybacking on chokidar's ignore regex.
      // A full gitignore parser is overkill — these three exclusions cover
      // the default `mandu init` templates and every shipped example app.
    ],
  });

  watcher.on("add", handle);
  watcher.on("change", handle);
  watcher.on("unlink", handle);
  watcher.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(theme.error(`[watch] watcher error: ${message}`));
  });

  const shutdown = (): void => {
    void watcher.close();
    if (timer) clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Block until a signal lands.
  await new Promise<void>(() => {
    /* intentionally unresolved — shutdown via SIGINT */
  });
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

  // ─── Phase 12.3 — Watch mode ──────────────────────────────────────
  if (opts.watch) {
    if (opts.dryRun) {
      const plan = await planWatch(opts, cwd, config);
      console.log(describeWatchPlan(plan));
      return true;
    }
    return runWatchMode(opts, cwd, config);
  }

  // ─── Phase 12.2 — E2E-only mode (no unit/integration) ─────────────
  // `--e2e` on its own implies the user wants ONLY the E2E pipeline —
  // we still run unit/integration first if the target was "all" and
  // --dry-run is OFF, but --dry-run + --e2e short-circuits to the plan.
  if (opts.e2e && opts.dryRun) {
    const out = await runE2EPipeline({
      cwd,
      dryRun: true,
      heal: Boolean(opts.heal),
      coverage: Boolean(opts.coverage),
      baseURL: opts.baseURL,
      ci: opts.ci,
      onlyRoutes: opts.onlyRoutes,
    });
    return out.ok;
  }

  // ─── Regular unit/integration pipeline ────────────────────────────
  let unitOk = true;
  let integrationOk = true;

  if (target === "unit") {
    unitOk = await runTarget("unit", config, opts, cwd);
  } else if (target === "integration") {
    integrationOk = await runTarget("integration", config, opts, cwd);
  } else {
    // target === "all"
    unitOk = await runTarget("unit", config, opts, cwd);
    if (!unitOk && opts.bail) return false;
    integrationOk = await runTarget("integration", config, opts, cwd);
  }

  const bunOk = unitOk && integrationOk;

  // ─── Phase 12.2 — E2E leg after bun test ──────────────────────────
  let e2eLcovPath: string | null = null;
  let e2eOk = true;
  if (opts.e2e) {
    const e2eOut = await runE2EPipeline({
      cwd,
      dryRun: false,
      heal: Boolean(opts.heal),
      coverage: Boolean(opts.coverage),
      baseURL: opts.baseURL,
      ci: opts.ci,
      onlyRoutes: opts.onlyRoutes,
    });
    e2eOk = e2eOut.ok;
    e2eLcovPath = e2eOut.lcovPath;
  }

  // ─── Phase 12.3 — Coverage merge (after everything has run) ───────
  if (opts.coverage) {
    const merged = await mergeCoverageOutputs({ cwd, e2eLcov: e2eLcovPath });
    if (merged.outputPath) {
      console.log(
        theme.muted(
          `[coverage] merged ${merged.files} file record(s) → ${merged.outputPath}`,
        ),
      );
      const threshold = config.coverage.lines;
      if (!enforceCoverageThreshold(merged.outputPath, threshold)) {
        return false;
      }
    }
  }

  return bunOk && e2eOk;
}

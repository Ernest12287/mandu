/**
 * ATE Watch Mode
 *
 * Watches source files for changes and re-runs only the affected
 * E2E tests (subset) for routes impacted by those changes.
 *
 * Unlike `computeImpact()` which relies on `git diff`, the watcher
 * operates on the filesystem directly: it collects changed paths from
 * `fs.watch`, then uses the ATE dependency graph to determine which
 * routes are affected before running the pipeline.
 */

import { watch as fsWatch, existsSync, type FSWatcher } from "node:fs";
import { resolve, join, extname } from "node:path";
import type { OracleLevel, InteractionGraph } from "./types";
import { getAtePaths, readJson } from "./fs";

export interface AteWatchOptions {
  repoRoot: string;
  baseURL?: string;
  oracleLevel?: OracleLevel;
  /** Debounce window for collecting rapid file changes (default 300ms) */
  debounceMs?: number;
  /** Directories to watch relative to repoRoot. Defaults to app/, src/, tests/e2e/ */
  watchDirs?: string[];
  /** Called right before a subset run starts */
  onTestStart?: (routes: string[]) => void;
  /** Called after a subset run finishes */
  onTestComplete?: (result: WatchTestResult) => void;
  /** Optional custom logger (defaults to console) */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface WatchTestResult {
  changedFiles: string[];
  affectedRoutes: string[];
  exitCode: number;
  durationMs: number;
  /** True when no affected routes were found and the run was skipped */
  skipped?: boolean;
  /** Non-fatal error message if the pipeline run threw */
  error?: string;
}

export interface AteWatcher {
  start(): Promise<void>;
  stop(): void;
  /** Manually trigger a run for a set of changed file paths (used by tests). */
  triggerForFiles(files: string[]): Promise<WatchTestResult>;
}

const WATCHABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const DEFAULT_WATCH_DIRS = ["app", "src", "tests/e2e"];

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeAbs(path: string, rootDir: string): string {
  return toPosix(resolve(rootDir, path));
}

/**
 * Create an ATE watcher. The returned object controls the watcher lifecycle.
 */
export function createAteWatcher(options: AteWatchOptions): AteWatcher {
  const repoRoot = options.repoRoot;
  const debounceMs = options.debounceMs ?? 300;
  const oracleLevel: OracleLevel = options.oracleLevel ?? "L1";
  const logger = options.logger ?? console;
  const watchDirs = options.watchDirs ?? DEFAULT_WATCH_DIRS;

  const watchers: FSWatcher[] = [];
  const pendingChanges = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let queued = false;
  let stopped = false;

  /**
   * Resolve affected routes for a set of changed files.
   * Falls back to direct file matching if dep-graph build fails.
   */
  async function computeAffectedRoutes(
    changedFiles: string[],
  ): Promise<{ affectedRoutes: string[]; warnings: string[] }> {
    const warnings: string[] = [];
    const paths = getAtePaths(repoRoot);

    if (!existsSync(paths.interactionGraphPath)) {
      warnings.push(
        `Interaction graph not found at ${paths.interactionGraphPath}; run 'mandu test:auto' first`,
      );
      return { affectedRoutes: [], warnings };
    }

    let graph: InteractionGraph;
    try {
      graph = readJson<InteractionGraph>(paths.interactionGraphPath);
    } catch (err: unknown) {
      warnings.push(
        `Failed to read interaction graph: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { affectedRoutes: [], warnings };
    }

    const routes = (graph.nodes ?? []).filter(
      (n): n is { kind: "route"; id: string; file: string; path: string } =>
        n.kind === "route",
    );

    if (routes.length === 0) {
      return { affectedRoutes: [], warnings };
    }

    const selected = new Set<string>();

    // 1. Direct file match
    const normalizedChanged = changedFiles.map((f) => normalizeAbs(f, repoRoot));
    for (const changed of normalizedChanged) {
      for (const r of routes) {
        if (normalizeAbs(r.file, repoRoot) === changed) {
          selected.add(r.id);
        }
      }
    }

    // 2. Transitive impact via dependency graph
    try {
      const { buildDependencyGraph, findDependents } = await import("./dep-graph");
      const depGraph = await buildDependencyGraph({
        rootDir: repoRoot,
        include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
        exclude: ["**/node_modules/**", "**/*.test.ts", "**/*.spec.ts"],
      });

      for (const changed of normalizedChanged) {
        const affectedFiles = findDependents(depGraph, changed);
        for (const affectedFile of affectedFiles) {
          for (const r of routes) {
            if (normalizeAbs(r.file, repoRoot) === affectedFile) {
              selected.add(r.id);
            }
          }
        }
      }
    } catch (err: unknown) {
      warnings.push(
        `Dep-graph build failed, using direct-match only: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { affectedRoutes: Array.from(selected), warnings };
  }

  /**
   * Run the ATE pipeline for a subset of routes. Non-throwing.
   */
  async function runSubset(changedFiles: string[]): Promise<WatchTestResult> {
    const startedAt = Date.now();
    const { affectedRoutes, warnings } = await computeAffectedRoutes(changedFiles);

    for (const w of warnings) logger.warn(`[ATE Watch] ${w}`);

    if (affectedRoutes.length === 0) {
      logger.log(
        `[ATE Watch] No affected routes for ${changedFiles.length} changed file(s); skipping run`,
      );
      const result: WatchTestResult = {
        changedFiles,
        affectedRoutes: [],
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        skipped: true,
      };
      options.onTestComplete?.(result);
      return result;
    }

    logger.log(
      `[ATE Watch] Running ${affectedRoutes.length} affected route(s): ${affectedRoutes.join(", ")}`,
    );
    options.onTestStart?.(affectedRoutes);

    let exitCode = -1;
    let error: string | undefined;
    try {
      // Fire-and-forget pattern: we await inside the current run slot, but the
      // main process loop is never blocked because `runSubset` is itself called
      // asynchronously from the debounce timer.
      const { ateExtract, ateGenerate, ateRun, ateReport } = await import("./index");
      await ateExtract({ repoRoot });
      await ateGenerate({ repoRoot, oracleLevel, onlyRoutes: affectedRoutes });
      const runRes = await ateRun({
        repoRoot,
        baseURL: options.baseURL,
        onlyRoutes: affectedRoutes,
      });
      exitCode = runRes.exitCode;
      try {
        await ateReport({
          repoRoot,
          runId: runRes.runId,
          startedAt: runRes.startedAt,
          finishedAt: runRes.finishedAt,
          exitCode,
          oracleLevel,
          impact: {
            mode: "subset",
            changedFiles,
            selectedRoutes: affectedRoutes,
          },
        });
      } catch (reportErr: unknown) {
        logger.warn(
          `[ATE Watch] Report generation failed: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`,
        );
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
      logger.error(`[ATE Watch] Pipeline run failed: ${error}`);
    }

    const result: WatchTestResult = {
      changedFiles,
      affectedRoutes,
      exitCode,
      durationMs: Date.now() - startedAt,
      error,
    };
    logger.log(
      `[ATE Watch] ${exitCode === 0 ? "PASS" : "FAIL"} in ${result.durationMs}ms`,
    );
    options.onTestComplete?.(result);
    return result;
  }

  /**
   * Concurrency-guarded scheduler. If a run is in progress, queues another run
   * for after the current one completes, coalescing pending changes.
   */
  async function scheduleRun(): Promise<void> {
    if (stopped) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      while (pendingChanges.size > 0) {
        const batch = Array.from(pendingChanges);
        pendingChanges.clear();
        queued = false;
        await runSubset(batch);
        if (!queued) break;
      }
    } finally {
      running = false;
    }
  }

  function handleChange(dirAbs: string, filename: string | null): void {
    if (!filename) return;
    const ext = extname(filename);
    if (!WATCHABLE_EXTS.has(ext)) return;
    const abs = toPosix(join(dirAbs, filename));
    pendingChanges.add(abs);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Fire-and-forget: never block the event loop on pipeline runs.
      void scheduleRun();
    }, debounceMs);
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      let watchedCount = 0;
      for (const rel of watchDirs) {
        const abs = resolve(repoRoot, rel);
        if (!existsSync(abs)) {
          logger.warn(`[ATE Watch] Skipping missing directory: ${rel}`);
          continue;
        }
        try {
          const w = fsWatch(abs, { recursive: true }, (_event, filename) => {
            handleChange(abs, typeof filename === "string" ? filename : null);
          });
          w.on("error", (err) => {
            logger.warn(`[ATE Watch] Watcher error on ${rel}: ${err.message}`);
          });
          watchers.push(w);
          watchedCount++;
        } catch (err: unknown) {
          logger.warn(
            `[ATE Watch] Failed to watch ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (watchedCount === 0) {
        logger.warn(
          "[ATE Watch] No directories are being watched. Create app/, src/, or tests/e2e/ first.",
        );
      } else {
        logger.log(
          `[ATE Watch] Watching ${watchedCount} director${watchedCount === 1 ? "y" : "ies"} (debounce ${debounceMs}ms). Press Ctrl+C to stop.`,
        );
      }
    },

    stop(): void {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      watchers.length = 0;
      pendingChanges.clear();
    },

    async triggerForFiles(files: string[]): Promise<WatchTestResult> {
      for (const f of files) pendingChanges.add(toPosix(resolve(repoRoot, f)));
      // Bypass debounce for programmatic triggers; still respect concurrency.
      const batch = Array.from(pendingChanges);
      pendingChanges.clear();
      return runSubset(batch);
    },
  };
}

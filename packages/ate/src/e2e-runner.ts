/**
 * ATE E2E runner — Phase 12.2
 *
 * Wraps `playwright test` with:
 *
 * - A spawn guard so a missing `@playwright/test` peer-dep produces a
 *   concrete, actionable error instead of a cryptic ENOENT.
 * - Uniform timeout + result surface (`E2ERunResult`) so callers (CLI,
 *   watcher, heal loop) all see the same shape regardless of the
 *   underlying Playwright exit path.
 * - A separate, opt-in `--coverage` pathway that adds `PW_COVERAGE=1`
 *   to the env and returns the path of the `coverage/lcov.info`
 *   file Playwright is expected to write (merger lives in
 *   `coverage-merger.ts`).
 *
 * This module intentionally does NOT depend on `@playwright/test` at
 * import time. Playwright is a peer dep; we discover it via `bunx`
 * lookup so the main Mandu CLI still works when Playwright is not
 * installed (and tells the user how to install it when `--e2e` is
 * requested).
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Input to `runE2E`. */
export interface RunE2EInput {
  /** Project root (where `tests/e2e/playwright.config.ts` lives). */
  repoRoot: string;
  /** Base URL Playwright should hit. Default: `http://localhost:3333`. */
  baseURL?: string;
  /**
   * Subset of route identifiers to run. Passed to Playwright via `--grep`
   * with each element regex-escaped and joined with `|`.
   */
  onlyRoutes?: string[];
  /** CI mode — forwarded to Playwright. Default: unset (preserves TTY). */
  ci?: boolean;
  /**
   * When true, enable Playwright V8 coverage via `PW_COVERAGE=1` env var.
   * The spec files are expected to honor this (our template already does).
   */
  coverage?: boolean;
  /** Hard timeout for the whole run. Default 10 minutes. */
  timeoutMs?: number;
  /**
   * Override the browser binary list. Forwarded to Playwright as
   * `--project=<browser>`.
   */
  browsers?: Array<"chromium" | "firefox" | "webkit">;
  /**
   * Absolute path to a custom `playwright.config.*` file. Default:
   * `<repoRoot>/tests/e2e/playwright.config.ts`.
   */
  configPath?: string;
  /**
   * Custom spawn implementation — used by tests to intercept the
   * subprocess layer. Default: `node:child_process.spawn`.
   */
  spawnImpl?: typeof spawn;
}

/** Outcome surfaced to the CLI / watcher. */
export interface E2ERunResult {
  /** Zero = all green. Non-zero = failures or infra error. */
  readonly exitCode: number;
  /** Seconds spent executing (monotonic). */
  readonly durationMs: number;
  /** Path of the LCOV coverage file Playwright was instructed to emit. */
  readonly lcovPath: string | null;
  /** Discovered-but-missing peer dependency, when detected pre-spawn. */
  readonly missingPeer: string | null;
  /**
   * Non-fatal note attached to the run (e.g. "timeout", "config not
   * found"). Empty array when everything went smoothly.
   */
  readonly warnings: string[];
}

/** Plan output for `--dry-run`. */
export interface E2EPlan {
  readonly cmd: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly lcovPath: string | null;
  readonly warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_BASE_URL = "http://localhost:3333";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Relative path under repoRoot where Playwright is instructed to write LCOV. */
export const E2E_COVERAGE_RELATIVE = "coverage/e2e.lcov";

/** Regex-escape a grep literal so `--grep` sees a safe pattern. */
function escapeGrep(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check whether Playwright is resolvable from `repoRoot`. We look for
 * `node_modules/@playwright/test` — the spawn is via `bunx`, so the
 * binary must be discoverable via the project's node_modules.
 *
 * Returns the missing package name when not found, `null` when OK.
 */
export function findMissingPlaywright(repoRoot: string): string | null {
  const candidates = [
    join(repoRoot, "node_modules", "@playwright", "test", "package.json"),
    join(repoRoot, "node_modules", "playwright", "package.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return null;
  }
  return "@playwright/test";
}

/**
 * Build the argv vector for the Playwright invocation. Exported so
 * tests can assert composition without spawning.
 */
export function buildPlaywrightArgs(input: RunE2EInput): {
  readonly cmd: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly configPath: string;
  readonly lcovPath: string | null;
} {
  const configPath =
    input.configPath ?? join(input.repoRoot, "tests", "e2e", "playwright.config.ts");
  const baseURL = input.baseURL ?? DEFAULT_BASE_URL;

  // Use `bunx playwright test` — mirrors the project convention (#139
  // memory: `child_process.spawn` for Playwright since runner.ts).
  const cmd = "bunx";
  const args = ["playwright", "test", "--config", configPath];

  if (input.onlyRoutes && input.onlyRoutes.length > 0) {
    args.push("--grep", input.onlyRoutes.map(escapeGrep).join("|"));
  }

  if (input.browsers && input.browsers.length > 0) {
    for (const b of input.browsers) args.push("--project", b);
  }

  const env: Record<string, string> = {
    BASE_URL: baseURL,
  };
  if (input.ci) env.CI = "true";

  let lcovPath: string | null = null;
  if (input.coverage) {
    lcovPath = join(input.repoRoot, E2E_COVERAGE_RELATIVE);
    env.PW_COVERAGE = "1";
    env.PW_COVERAGE_OUTPUT = lcovPath;
  }

  return { cmd, args, env, configPath, lcovPath };
}

/**
 * Build the dry-run plan without touching the process layer. Used by
 * `mandu test --e2e --dry-run` to print the intended invocation.
 */
export function planE2ERun(input: RunE2EInput): E2EPlan {
  const { cmd, args, env, configPath, lcovPath } = buildPlaywrightArgs(input);
  const warnings: string[] = [];
  const missing = findMissingPlaywright(input.repoRoot);
  if (missing) {
    warnings.push(
      `Playwright peer dep not installed (${missing}). ` +
        `Install with 'bun add -d @playwright/test' before running without --dry-run.`,
    );
  }
  if (!existsSync(configPath)) {
    warnings.push(
      `Playwright config not found at ${configPath}. ` +
        `Create tests/e2e/playwright.config.ts or pass --config.`,
    );
  }
  return {
    cmd,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
    cwd: input.repoRoot,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    lcovPath,
    warnings,
  };
}

/**
 * Spawn Playwright and await completion. Non-throwing — errors are
 * surfaced via the returned `exitCode` and `warnings`.
 */
export async function runE2E(input: RunE2EInput): Promise<E2ERunResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];

  // Pre-flight: missing peer is a config error (exit 4 in CLI).
  const missing = findMissingPlaywright(input.repoRoot);
  if (missing) {
    return {
      exitCode: 4,
      durationMs: Date.now() - startedAt,
      lcovPath: null,
      missingPeer: missing,
      warnings: [
        `Playwright peer dep not installed (${missing}). ` +
          `Run 'bun add -d @playwright/test' to add it.`,
      ],
    };
  }

  const { cmd, args, env, lcovPath } = buildPlaywrightArgs(input);
  const spawnFn = input.spawnImpl ?? spawn;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let child;
  try {
    child = spawnFn(cmd, args, {
      cwd: input.repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
  } catch (err: unknown) {
    return {
      exitCode: 2,
      durationMs: Date.now() - startedAt,
      lcovPath: null,
      missingPeer: null,
      warnings: [
        `Failed to spawn Playwright: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const exitCode: number = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      warnings.push(`Playwright run exceeded timeout (${timeoutMs}ms); killed.`);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve(124);
    }, timeoutMs);

    child.on("exit", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? 1);
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      warnings.push(`Playwright spawn error: ${err.message}`);
      resolve(2);
    });
  });

  return {
    exitCode,
    durationMs: Date.now() - startedAt,
    lcovPath: lcovPath && existsSync(lcovPath) ? lcovPath : null,
    missingPeer: null,
    warnings,
  };
}

/**
 * Render the plan as a human-readable block. Used by `--dry-run`.
 */
export function describeE2EPlan(plan: E2EPlan): string {
  const lines: string[] = [];
  lines.push(`ATE E2E execution plan`);
  lines.push(`  cwd:         ${plan.cwd}`);
  lines.push(`  command:     ${plan.cmd} ${plan.args.join(" ")}`);
  lines.push(`  timeout:     ${plan.timeoutMs}ms`);
  lines.push(`  lcov output: ${plan.lcovPath ?? "(coverage off)"}`);
  if (plan.warnings.length > 0) {
    lines.push(`  warnings:`);
    for (const w of plan.warnings) lines.push(`    - ${w}`);
  }
  return lines.join("\n");
}

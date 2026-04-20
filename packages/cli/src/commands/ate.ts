/**
 * `mandu ate <subcommand>` — Phase A.3 / Phase B CLI entry.
 *
 * Subcommands:
 *   - `lint-exemplars` (A.3): scans the repo for `@ate-exemplar:` / `@ate-exemplar-anti:` tags.
 *   - `memory clear`  (B.2): delete .mandu/ate-memory.jsonl.
 *   - `memory stats`  (B.2): print per-kind event counts + file size + oldest/newest timestamps.
 *   - `watch`         (B.3): chokidar + 1s debounce + auto-run `computeImpactV2({ since: "working" })`.
 */

import { theme } from "../terminal";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface AteCliOptions {
  /** Repository root. Default = cwd. */
  repoRoot?: string;
  /** Emit JSON instead of human text. */
  json?: boolean;
}

export async function runAteCommand(args: string[], opts: AteCliOptions = {}): Promise<boolean> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return true;
  }

  switch (sub) {
    case "lint-exemplars":
      return runLintExemplars(opts);
    case "memory":
      return runMemoryCommand(args.slice(1), opts);
    case "watch":
      return runWatchCommand(args.slice(1), opts);
    default:
      console.error(theme.error(`Unknown 'mandu ate' subcommand: ${sub}`));
      printHelp();
      return false;
  }
}

function printHelp(): void {
  const lines = [
    "",
    "  mandu ate — Phase A/B agent-native tooling",
    "",
    "  Subcommands:",
    "    lint-exemplars   Validate every @ate-exemplar: tag points to a runnable test",
    "    memory clear     Delete .mandu/ate-memory.jsonl",
    "    memory stats     Summarize .mandu/ate-memory.jsonl (per-kind counts + size)",
    "    watch            Re-run impact v2 on filesystem changes (1s debounce)",
    "",
    "  Flags (apply to subcommands that support them):",
    "    --json           Emit JSON summary to stdout",
    "",
  ];
  console.log(lines.join("\n"));
}

// ──────────────────────────────────────────────────────────────────────────
// lint-exemplars
// ──────────────────────────────────────────────────────────────────────────

export interface LintExemplarsReport {
  scanned: number;
  positive: number;
  anti: number;
  issues: Array<{
    kind: "orphan" | "malformed" | "anti_missing_reason" | "unknown_kind";
    path: string;
    line: number;
    detail: string;
  }>;
}

const KNOWN_KINDS = new Set([
  "filling_unit",
  "filling_integration",
  "e2e_playwright",
  // Phase B.5 — new prompt kinds.
  "property_based",
  "contract_shape",
  "guard_security",
]);

export async function lintExemplars(repoRoot: string): Promise<LintExemplarsReport> {
  const { scanMarkers, scanExemplars } = await import("@mandujs/ate");

  const [markers, captured] = await Promise.all([
    scanMarkers(repoRoot),
    scanExemplars(repoRoot),
  ]);

  // Build a set of (path, line) for markers that successfully captured a block.
  const capturedKeys = new Set<string>(captured.map((e) => `${e.path}:${e.startLine}`));

  const issues: LintExemplarsReport["issues"] = [];
  let positive = 0;
  let anti = 0;

  for (const site of markers) {
    const key = `${site.path}:${site.line}`;

    if (site.marker.anti) anti++;
    else positive++;

    if (!capturedKeys.has(key)) {
      issues.push({
        kind: "orphan",
        path: site.path,
        line: site.line,
        detail:
          "Marker does not have a following test()/it()/describe() call. " +
          "Either remove it or add a test block immediately below.",
      });
    }

    if (site.marker.anti && !site.marker.reason) {
      issues.push({
        kind: "anti_missing_reason",
        path: site.path,
        line: site.line,
        detail:
          "@ate-exemplar-anti: must include a reason=\"...\" attribute explaining why the pattern is wrong.",
      });
    }

    if (site.marker.kind && !KNOWN_KINDS.has(site.marker.kind)) {
      issues.push({
        kind: "unknown_kind",
        path: site.path,
        line: site.line,
        detail: `Unknown exemplar kind '${site.marker.kind}'. Known: ${[...KNOWN_KINDS].join(", ")}`,
      });
    }
  }

  return {
    scanned: markers.length,
    positive,
    anti,
    issues,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// memory (Phase B.2)
// ──────────────────────────────────────────────────────────────────────────

async function runMemoryCommand(args: string[], opts: AteCliOptions): Promise<boolean> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log("\n  Usage: mandu ate memory [clear | stats]\n");
    return true;
  }
  const repoRoot = opts.repoRoot ?? process.cwd();
  const ate = await import("@mandujs/ate");

  if (sub === "clear") {
    const removed = ate.clearMemory(repoRoot);
    if (opts.json) {
      console.log(JSON.stringify({ removed, path: ate.memoryFilePath(repoRoot) }, null, 2));
    } else {
      console.log(
        removed
          ? theme.success(`  deleted ${ate.memoryFilePath(repoRoot)}`)
          : theme.info("  no memory file to delete"),
      );
    }
    return true;
  }

  if (sub === "stats") {
    const stats = ate.memoryStats(repoRoot);
    if (opts.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(`${theme.info("[ate memory]")} ${stats.path}`);
      console.log(`  total events: ${stats.total}`);
      console.log(`  bytes: ${stats.bytes}`);
      console.log(`  oldest: ${stats.oldestTimestamp ?? "(none)"}`);
      console.log(`  newest: ${stats.newestTimestamp ?? "(none)"}`);
      for (const [kind, count] of Object.entries(stats.byKind)) {
        console.log(`  ${kind}: ${count}`);
      }
    }
    return true;
  }

  console.error(theme.error(`Unknown 'mandu ate memory' subcommand: ${sub}`));
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// watch (Phase B.3)
// ──────────────────────────────────────────────────────────────────────────

/**
 * `mandu ate watch` — fs.watch + 1s debounce + computeImpactV2({ since: "working" }).
 *
 * Uses Node's built-in `fs.watch` (recursive) rather than chokidar to honour
 * the "no new runtime deps" constraint. On platforms where recursive
 * watchers are unavailable (non-macOS/Windows Linux kernels), a plain
 * non-recursive watcher on the project root still surfaces top-level
 * changes — deep changes will only trigger when those paths mutate.
 */
async function runWatchCommand(_args: string[], opts: AteCliOptions): Promise<boolean> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const absRoot = resolve(repoRoot);
  if (!existsSync(absRoot)) {
    console.error(theme.error(`repoRoot does not exist: ${absRoot}`));
    return false;
  }

  const fs = await import("node:fs");
  const ate = await import("@mandujs/ate");

  console.log(
    `${theme.info("[ate watch]")} debouncing 1s, watching ${absRoot} for working-tree changes. Ctrl+C to stop.`,
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const runImpact = async () => {
    if (running) return;
    running = true;
    try {
      const result = await ate.computeImpactV2({ repoRoot: absRoot, since: "working" });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `${theme.info("[ate watch]")} ${result.changed.files.length} changed file(s), ` +
            `${result.affected.specsToReRun.length} spec(s) to re-run, ` +
            `${result.suggestions.length} suggestion(s).`,
        );
        for (const s of result.suggestions.slice(0, 5)) {
          console.log(`  - [${s.kind}] ${s.target} — ${s.reasoning}`);
        }
      }
    } catch (err) {
      console.error(
        theme.error(`  impact error: ${err instanceof Error ? err.message : String(err)}`),
      );
    } finally {
      running = false;
    }
  };

  const onAnyChange = (_event: string, filename: string | null) => {
    if (!filename) return;
    // Ignore noisy paths.
    if (/node_modules|\.mandu|\.git|dist[\\/]/.test(filename)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runImpact();
    }, 1000);
  };

  let watcher: ReturnType<typeof fs.watch> | null = null;
  try {
    watcher = fs.watch(absRoot, { recursive: true }, onAnyChange);
  } catch (err) {
    console.error(
      theme.error(
        `recursive watch unsupported on this platform (${err instanceof Error ? err.message : String(err)}); falling back to top-level only`,
      ),
    );
    try {
      watcher = fs.watch(absRoot, onAnyChange);
    } catch (err2) {
      console.error(
        theme.error(
          `fs.watch failed outright: ${err2 instanceof Error ? err2.message : String(err2)}`,
        ),
      );
      return false;
    }
  }

  await new Promise<void>((resolveKeep) => {
    const stop = () => {
      watcher?.close();
      if (timer) clearTimeout(timer);
      resolveKeep();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return true;
}

async function runLintExemplars(opts: AteCliOptions): Promise<boolean> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const report = await lintExemplars(repoRoot);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${theme.info("[ate]")} scanned ${report.scanned} exemplar marker(s) — ` +
        `${report.positive} positive, ${report.anti} anti`
    );
    if (report.issues.length === 0) {
      console.log(theme.success("  all exemplars look good"));
    } else {
      console.log(theme.error(`  ${report.issues.length} issue(s):`));
      for (const iss of report.issues) {
        console.log(`  - [${iss.kind}] ${iss.path}:${iss.line} — ${iss.detail}`);
      }
    }
  }

  return report.issues.length === 0;
}

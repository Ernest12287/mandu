/**
 * `mandu ate <subcommand>` — Phase A.3 CLI entry.
 *
 * Subcommands:
 *   - `lint-exemplars`: scans the repo for `@ate-exemplar:` and
 *     `@ate-exemplar-anti:` tags, validates each points to a runnable
 *     test, and reports orphan / malformed markers. Exits 1 on any
 *     problem (CI-friendly).
 *
 * Additional subcommands are expected in later phases — `lint-prompts`,
 * `recall` / `memory` queries, etc.
 */

import { theme } from "../terminal";

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
    default:
      console.error(theme.error(`Unknown 'mandu ate' subcommand: ${sub}`));
      printHelp();
      return false;
  }
}

function printHelp(): void {
  const lines = [
    "",
    "  mandu ate — Phase A.3 agent-native tooling",
    "",
    "  Subcommands:",
    "    lint-exemplars   Validate every @ate-exemplar: tag points to a runnable test",
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

const KNOWN_KINDS = new Set(["filling_unit", "filling_integration", "e2e_playwright"]);

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

/**
 * MCP tools — `mandu.lint` + `mandu.lint.setup`
 *
 * Gives agents a first-class way to:
 *   1. Run oxlint on a project and get structured error/warning counts
 *      (read-only, no side effects).
 *   2. One-shot install oxlint + scaffold `.oxlintrc.json` + wire
 *      scripts on an existing project (destructive — writes files).
 *
 * The setup tool mirrors `mandu lint --setup`. We spawn the CLI as a
 * subprocess rather than linking to the CLI source so MCP builds
 * don't pull `packages/cli` into their import graph.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import fs from "node:fs/promises";

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

async function oxlintAvailable(rootDir: string): Promise<boolean> {
  const binName = process.platform === "win32" ? "oxlint.exe" : "oxlint";
  const localBin = path.resolve(rootDir, "node_modules", ".bin", binName);
  try {
    await fs.access(localBin);
    return true;
  } catch {
    // Not in local node_modules — probe PATH.
  }
  try {
    const proc = Bun.spawn({
      cmd: ["bun", "x", "oxlint", "--version"],
      cwd: rootDir,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

interface LintParsed {
  errors: number;
  warnings: number;
  raw: string;
  parseFailed: boolean;
}

async function runOxlintOnce(rootDir: string, typeAware: boolean): Promise<LintParsed> {
  const cmd = typeAware
    ? ["bun", "x", "oxlint", "--type-aware", "."]
    : ["bun", "x", "oxlint", "."];
  const proc = Bun.spawn({
    cmd,
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const raw = stderr + stdout;
  const match = raw.match(/Found (\d+) warnings? and (\d+) errors?/);
  if (!match) {
    return { errors: 0, warnings: 0, raw, parseFailed: true };
  }
  return {
    errors: Number(match[2]),
    warnings: Number(match[1]),
    raw,
    parseFailed: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// mandu.lint — run oxlint, return counts
// ─────────────────────────────────────────────────────────────────────────

interface LintInput {
  typeAware?: unknown;
}

interface LintResult {
  installed: boolean;
  ran: boolean;
  errors: number;
  warnings: number;
  passed: boolean;
  hint?: string;
  rawTail?: string;
}

async function handleLint(projectRoot: string, input: LintInput): Promise<LintResult> {
  const typeAware = input.typeAware === true;
  const installed = await oxlintAvailable(projectRoot);
  if (!installed) {
    return {
      installed: false,
      ran: false,
      errors: 0,
      warnings: 0,
      passed: false,
      hint:
        "oxlint is not installed in this project. Call `mandu.lint.setup` or run `mandu lint --setup` in the shell to install + configure.",
    };
  }
  const result = await runOxlintOnce(projectRoot, typeAware);
  if (result.parseFailed) {
    return {
      installed: true,
      ran: true,
      errors: 0,
      warnings: 0,
      passed: false,
      hint: "oxlint ran but output could not be parsed. See `rawTail` for the last 2 KB.",
      rawTail: result.raw.slice(-2048),
    };
  }
  return {
    installed: true,
    ran: true,
    errors: result.errors,
    warnings: result.warnings,
    passed: result.errors === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// mandu.lint.setup — install oxlint + wire scripts + baseline
// ─────────────────────────────────────────────────────────────────────────

interface LintSetupInput {
  dryRun?: unknown;
}

interface LintSetupResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  dryRun: boolean;
  hint?: string;
}

async function handleLintSetup(projectRoot: string, input: LintSetupInput): Promise<LintSetupResult> {
  const dryRun = input.dryRun === true;
  const args = ["run", "--cwd", projectRoot, "mandu", "lint", "--setup", "--yes"];
  if (dryRun) args.push("--dry-run");
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const ok = exitCode === 0;
  return {
    ok,
    stdout,
    stderr,
    exitCode,
    dryRun,
    hint: ok
      ? dryRun
        ? "Dry-run completed. Re-run without `dryRun: true` to apply the changes."
        : "Setup completed. Run `mandu.lint` to see the current baseline."
      : "Setup command failed. See `stderr` for details. A frequent cause is `mandu` CLI not being installed — `bun add -D @mandujs/cli` in the project first.",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool definitions + handler map
// ─────────────────────────────────────────────────────────────────────────

export const lintToolDefinitions: Tool[] = [
  {
    name: "mandu.lint",
    description:
      "Run oxlint on the project and return structured error/warning counts. Read-only — never modifies files. Pass `typeAware: true` to also run `oxlint --type-aware` (requires `oxlint-tsgolint`). Agents should call this after edits as part of the guardrail chain alongside `mandu.guard.check` and `mandu.doctor`.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        typeAware: {
          type: "boolean",
          description:
            "Run `oxlint --type-aware` in addition to the core pass (requires `oxlint-tsgolint`). Default false.",
        },
      },
      required: [],
    },
  },
  {
    name: "mandu.lint.setup",
    description:
      "Install oxlint into an existing project: copies `.oxlintrc.json`, wires `lint`/`lint:fix` scripts, adds `oxlint` devDep, runs `bun install`. Idempotent — re-running produces no additional changes. Destructive — writes files. Set `dryRun: true` to print the plan only.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description: "Print the plan without writing files. Default false.",
        },
      },
      required: [],
    },
  },
];

export function lintTools(projectRoot: string) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    "mandu.lint": async (args) => handleLint(projectRoot, args as LintInput),
    "mandu.lint.setup": async (args) => handleLintSetup(projectRoot, args as LintSetupInput),
  };
  return handlers;
}

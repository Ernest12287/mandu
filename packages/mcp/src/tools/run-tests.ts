/**
 * MCP tool — `mandu.run.tests`
 *
 * Invokes `mandu test` as a child process via `Bun.spawn` and parses the
 * resulting Bun test output into a structured summary:
 *
 *   { passed, failed, skipped, failing_tests: [{ name, file, error }] }
 *
 * Design notes:
 *   • Input is validated against a minimal runtime schema (see `validateInput`).
 *     Bad input produces a structured `{ error, field, hint }` object — the
 *     error-handler's `isSoftErrorResult` detector will surface this as
 *     `isError: true` to MCP clients.
 *   • If no test files are discovered we return `{ passed: 0, failed: 0,
 *     skipped: 0, note: "no test files" }` without failing the caller.
 *   • The child process is spawned with a 10-minute ceiling via Promise.race —
 *     well above normal test suites but short enough that a stuck process
 *     never hangs the MCP server.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "bun";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

type RunTarget = "unit" | "integration" | "e2e" | "all";

interface RunTestsInput {
  target?: RunTarget;
  filter?: string;
  coverage?: boolean;
}

interface FailingTest {
  name: string;
  file?: string;
  error?: string;
}

interface RunTestsResult {
  target: RunTarget;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms?: number;
  failing_tests: FailingTest[];
  exit_code: number;
  note?: string;
  /** Trailing 2000 chars of stdout for diagnostic context. */
  stdout_tail?: string;
  /** Trailing 2000 chars of stderr for diagnostic context. */
  stderr_tail?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────

const VALID_TARGETS = new Set<RunTarget>(["unit", "integration", "e2e", "all"]);
const COMMAND_TIMEOUT_MS = 10 * 60_000;

function validateInput(raw: Record<string, unknown>): {
  ok: true;
  value: Required<Pick<RunTestsInput, "target" | "coverage">> &
    Pick<RunTestsInput, "filter">;
} | { ok: false; error: string; field: string; hint: string } {
  const target = raw.target ?? "all";
  if (typeof target !== "string" || !VALID_TARGETS.has(target as RunTarget)) {
    return {
      ok: false,
      error: "Invalid 'target' — expected 'unit', 'integration', 'e2e', or 'all'",
      field: "target",
      hint: "Omit to default to 'all'",
    };
  }

  const filter = raw.filter;
  if (filter !== undefined && typeof filter !== "string") {
    return {
      ok: false,
      error: "'filter' must be a string",
      field: "filter",
      hint: "Pass a bun-test filter pattern, e.g. 'my-describe > my-case'",
    };
  }

  const coverage = raw.coverage;
  if (coverage !== undefined && typeof coverage !== "boolean") {
    return {
      ok: false,
      error: "'coverage' must be a boolean",
      field: "coverage",
      hint: "Pass true to emit a coverage report",
    };
  }

  return {
    ok: true,
    value: {
      target: target as RunTarget,
      coverage: coverage === true,
      ...(typeof filter === "string" && filter.length > 0 ? { filter } : {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Parser — Bun test output → RunTestsResult
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse bun-test style output. Bun emits:
 *   `(pass) describe > test`
 *   `(fail) describe > test`
 *   `(skip) describe > test`
 *
 * And a trailing summary block:
 *   `N pass`
 *   `M fail`
 *   `K skipped`
 *   `Ran ... tests across ... files. [x.xxs]`
 *
 * This parser is intentionally forgiving: counts are taken from the
 * explicit summary lines when present, else derived from `(pass|fail|skip)`
 * markers.
 */
export function parseBunTestOutput(raw: string): {
  passed: number;
  failed: number;
  skipped: number;
  duration_ms?: number;
  failing_tests: FailingTest[];
} {
  const lines = raw.split(/\r?\n/);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration_ms: number | undefined;
  const failing_tests: FailingTest[] = [];

  let currentFile: string | undefined;
  let pendingFailure: FailingTest | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track the current file heading (e.g. "src/foo.test.ts:"):
    const fileMatch = /^([^\s()]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)):$/.exec(trimmed);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // `(fail) ...` → start a failing test record.
    const failMatch = /^\(fail\)\s+(.+)$/.exec(trimmed);
    if (failMatch) {
      if (pendingFailure) {
        failing_tests.push(pendingFailure);
      }
      pendingFailure = {
        name: failMatch[1].trim(),
        file: currentFile,
      };
      continue;
    }

    // `(skip) ...` counts as skipped but doesn't emit a record.
    if (/^\(skip\)\s+/.test(trimmed)) {
      continue;
    }

    // If we're inside a failure block, capture the first few non-empty
    // lines that follow as error context.
    if (pendingFailure && trimmed.length > 0) {
      const isNextTestMarker = /^\(pass|fail|skip\)/.test(trimmed);
      if (!isNextTestMarker) {
        pendingFailure.error = pendingFailure.error
          ? `${pendingFailure.error}\n${trimmed}`
          : trimmed;
        // Cap the captured error to keep payloads tight.
        if (pendingFailure.error.length > 800) {
          pendingFailure.error = pendingFailure.error.slice(0, 800);
        }
        continue;
      }
    }

    // End-of-block marker flushes the current failure record.
    if (pendingFailure && (trimmed.length === 0 || /^\d+\s+(pass|fail|skipped)\b/.test(trimmed))) {
      failing_tests.push(pendingFailure);
      pendingFailure = null;
    }

    // Totals block — authoritative if present.
    const passMatch = /^(\d+)\s+pass\b/.exec(trimmed);
    if (passMatch) {
      passed = Number(passMatch[1]);
      continue;
    }
    const failSumMatch = /^(\d+)\s+fail\b/.exec(trimmed);
    if (failSumMatch) {
      failed = Number(failSumMatch[1]);
      continue;
    }
    const skipMatch = /^(\d+)\s+skipped\b/.exec(trimmed);
    if (skipMatch) {
      skipped = Number(skipMatch[1]);
      continue;
    }

    // Duration: `Ran 123 tests across 10 files. [1.23s]`
    const dur = /\[([\d.]+)s\]/.exec(trimmed);
    if (dur && /Ran\s+\d+\s+tests/.test(trimmed)) {
      duration_ms = Math.round(Number(dur[1]) * 1000);
    }
  }

  if (pendingFailure) {
    failing_tests.push(pendingFailure);
  }

  return { passed, failed, skipped, duration_ms, failing_tests };
}

// ─────────────────────────────────────────────────────────────────────────
// Child process invocation
// ─────────────────────────────────────────────────────────────────────────

function tailString(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return s.slice(-max);
}

function isNoTestFilesSignal(stdout: string, stderr: string): boolean {
  // Bun reports "0 tests" or exits with a "No tests found" banner depending
  // on version. We match on both variants.
  const combined = `${stdout}\n${stderr}`;
  if (/Ran\s+0\s+tests/i.test(combined)) return true;
  if (/No tests found/i.test(combined)) return true;
  if (/no test files/i.test(combined)) return true;
  return false;
}

/**
 * Resolve the `mandu` CLI entry. We prefer the workspace binary
 * (`packages/cli/src/main.ts`) when running inside the monorepo, else
 * fall back to `mandu` on PATH.
 *
 * The CLI entry is invoked directly via `bun run <path>` so users get
 * the version bundled with their project without relying on global installs.
 */
async function resolveManduCommand(projectRoot: string): Promise<string[]> {
  // Prefer a local `.bin/mandu` if the project installed `@mandujs/cli`.
  const localBin = path.join(projectRoot, "node_modules", ".bin", "mandu");
  try {
    const f = Bun.file(localBin);
    if (await f.exists()) {
      return ["bun", "run", localBin];
    }
  } catch {}

  // Monorepo: packages/cli/src/main.ts is directly executable via bun.
  const monorepoCli = path.resolve(projectRoot, "packages", "cli", "src", "main.ts");
  try {
    const f = Bun.file(monorepoCli);
    if (await f.exists()) {
      return ["bun", "run", monorepoCli];
    }
  } catch {}

  // Fallback: rely on PATH.
  return ["mandu"];
}

async function runProcess(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode: exitCode ?? 1, timedOut };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public handler
// ─────────────────────────────────────────────────────────────────────────

async function runManduTests(
  projectRoot: string,
  input: RunTestsInput,
): Promise<RunTestsResult | { error: string; field?: string; hint?: string }> {
  const validated = validateInput(input as Record<string, unknown>);
  if (!validated.ok) {
    return {
      error: validated.error,
      field: validated.field,
      hint: validated.hint,
    };
  }

  const { target, filter, coverage } = validated.value;

  const base = await resolveManduCommand(projectRoot);
  const args = [...base, "test"];
  if (target !== "all") args.push(target);
  if (filter) args.push("--filter", filter);
  if (coverage) args.push("--coverage");

  let proc: { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
  try {
    proc = await runProcess(args, projectRoot, COMMAND_TIMEOUT_MS);
  } catch (err) {
    return {
      error: `Failed to spawn test runner: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Verify that @mandujs/cli is installed and accessible",
    };
  }

  // No-tests case: the caller gets a benign zeroed summary.
  if (isNoTestFilesSignal(proc.stdout, proc.stderr) && proc.exitCode !== 0) {
    return {
      target,
      passed: 0,
      failed: 0,
      skipped: 0,
      failing_tests: [],
      exit_code: proc.exitCode,
      note: "no test files",
      stdout_tail: tailString(proc.stdout),
      stderr_tail: tailString(proc.stderr),
    };
  }

  const parsed = parseBunTestOutput(`${proc.stdout}\n${proc.stderr}`);

  const result: RunTestsResult = {
    target,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    failing_tests: parsed.failing_tests,
    exit_code: proc.exitCode,
    stdout_tail: tailString(proc.stdout),
    stderr_tail: tailString(proc.stderr),
  };
  if (parsed.duration_ms !== undefined) result.duration_ms = parsed.duration_ms;
  if (proc.timedOut) result.note = "timed out";
  if (parsed.passed === 0 && parsed.failed === 0 && parsed.skipped === 0) {
    result.note = result.note ?? "no test files";
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool definition + handler map
// ─────────────────────────────────────────────────────────────────────────

export const runTestsToolDefinitions: Tool[] = [
  {
    name: "mandu.run.tests",
    description:
      "Run the project's tests via `mandu test` and return a structured summary: passed / failed / skipped counts plus a list of failing tests with file and error context. Safe to call repeatedly — no writes, just spawns the child process and parses its output.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["unit", "integration", "e2e", "all"],
          description:
            "Which test target to run (default: 'all'). Maps directly to `mandu test <target>`.",
        },
        filter: {
          type: "string",
          description:
            "Forward `--filter <pattern>` to `bun test` — restricts to matching describe/it names.",
        },
        coverage: {
          type: "boolean",
          description: "Pass `--coverage` to emit a coverage report (default: false).",
        },
      },
      required: [],
    },
  },
];

export function runTestsTools(projectRoot: string) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    "mandu.run.tests": async (args) => runManduTests(projectRoot, args as RunTestsInput),
  };
  return handlers;
}

// Re-export with canonical snake-case alias for parsimony (used by tests).
export { parseBunTestOutput as parseTestOutput };

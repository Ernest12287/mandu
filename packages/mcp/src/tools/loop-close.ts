/**
 * MCP tool — `mandu.loop.close`
 *
 * Thin, safe adapter over `@mandujs/skills/loop-closure`. Given agent
 * output (stdout, stderr, exitCode), runs the built-in loop-closure
 * detectors and returns a structured follow-up prompt:
 *
 *   {
 *     stallReason: string,
 *     nextPrompt: string,
 *     evidence: Array<{ kind, file?, line?, snippet, label? }>
 *   }
 *
 * SAFETY INVARIANTS — enforced by design:
 *   - `closeLoop()` is pure: no I/O, no spawn, no file writes.
 *   - This wrapper adds only input validation + field shaping.
 *   - The `nextPrompt` is ADVISORY text. It is never auto-executed.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { closeLoop, listDetectorIds } from "@mandujs/skills/loop-closure";

interface LoopCloseInput {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  detectors?: unknown;
}

function validateInput(raw: Record<string, unknown>): {
  ok: true;
  value: {
    stdout: string;
    stderr: string;
    exitCode: number;
    detectors?: string[];
  };
} | { ok: false; error: string; field: string; hint: string } {
  const stdout = raw.stdout ?? "";
  if (typeof stdout !== "string") {
    return {
      ok: false,
      error: "'stdout' must be a string",
      field: "stdout",
      hint: "Omit or pass '' for no stdout",
    };
  }

  const stderr = raw.stderr ?? "";
  if (typeof stderr !== "string") {
    return {
      ok: false,
      error: "'stderr' must be a string",
      field: "stderr",
      hint: "Omit or pass '' for no stderr",
    };
  }

  let exitCode = 0;
  if (raw.exitCode !== undefined) {
    if (typeof raw.exitCode !== "number" || !Number.isFinite(raw.exitCode)) {
      return {
        ok: false,
        error: "'exitCode' must be a finite number",
        field: "exitCode",
        hint: "Pass the child-process exit code, typically 0 (success) or non-zero (failure)",
      };
    }
    exitCode = Math.trunc(raw.exitCode);
  }

  let detectors: string[] | undefined;
  if (raw.detectors !== undefined) {
    if (!Array.isArray(raw.detectors) ||
        !raw.detectors.every((d) => typeof d === "string")) {
      return {
        ok: false,
        error: "'detectors' must be an array of detector IDs",
        field: "detectors",
        hint: `Valid IDs: ${listDetectorIds().join(", ")}`,
      };
    }
    detectors = raw.detectors as string[];
  }

  return {
    ok: true,
    value: { stdout, stderr, exitCode, ...(detectors ? { detectors } : {}) },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────

async function runLoopClose(
  input: LoopCloseInput,
): Promise<
  | {
      stallReason: string;
      nextPrompt: string;
      evidence: Array<{
        kind: string;
        file?: string;
        line?: number;
        snippet: string;
        label?: string;
      }>;
      detectors_run: string[];
    }
  | { error: string; field?: string; hint?: string }
> {
  const validated = validateInput(input as Record<string, unknown>);
  if (!validated.ok) {
    return {
      error: validated.error,
      field: validated.field,
      hint: validated.hint,
    };
  }

  const report = closeLoop(validated.value);
  return {
    stallReason: report.stallReason,
    nextPrompt: report.nextPrompt,
    evidence: report.evidence,
    detectors_run: validated.value.detectors ?? listDetectorIds(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool definition + handler map
// ─────────────────────────────────────────────────────────────────────────

export const loopCloseToolDefinitions: Tool[] = [
  {
    name: "mandu.loop.close",
    description:
      "Analyze agent output (stdout, stderr, exitCode) and return a structured `nextPrompt` that names the primary stall pattern, explains how to address it, and lists supporting evidence. This tool is pure — it never writes files, spawns processes, or auto-executes anything. The returned prompt is advisory text only.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        stdout: {
          type: "string",
          description: "Captured stdout from the most recent command/run.",
        },
        stderr: {
          type: "string",
          description: "Captured stderr from the most recent command/run.",
        },
        exitCode: {
          type: "number",
          description: "Child-process exit code. Defaults to 0 when omitted.",
        },
        detectors: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional detector-ID allow-list. Omit to run the full built-in set.",
        },
      },
      required: [],
    },
  },
];

export function loopCloseTools(_projectRoot: string) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    "mandu.loop.close": async (args) => runLoopClose(args as LoopCloseInput),
  };
  return handlers;
}

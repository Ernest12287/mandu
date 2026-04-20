/**
 * `mandu_ate_remember` — Phase B.2 memory write tool.
 *
 * Snake_case (§11 decision #4). Idempotent append.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  appendMemoryEvent,
  parseMemoryEvent,
  type MemoryEvent,
} from "@mandujs/ate";

export const ateRememberToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_remember",
    description:
      "Phase B.2 memory write. Appends one event to the project-local " +
      ".mandu/ate-memory.jsonl. File auto-rotates to .bak when it crosses " +
      "10 MB. Supported event kinds (discriminated union by `kind`): " +
      "intent_history | rejected_spec | accepted_healing | rejected_healing " +
      "| prompt_version_drift | boundary_gap_filled | coverage_snapshot. " +
      "Timestamp defaults to now (ISO-8601 UTC) if omitted.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root.",
        },
        event: {
          type: "object",
          description:
            "MemoryEvent object. Must carry a `kind` discriminator plus the " +
            "event-kind-specific required fields (see @mandujs/ate memory/schema.ts).",
          additionalProperties: true,
        },
      },
      required: ["repoRoot", "event"],
    },
  },
];

export function ateRememberTools(_projectRoot: string) {
  return {
    mandu_ate_remember: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      const eventRaw = args.event;

      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      if (!eventRaw || typeof eventRaw !== "object") {
        return { ok: false, error: "event is required" };
      }

      // Default the timestamp if the caller omitted it (agents do).
      const draft = { ...(eventRaw as Record<string, unknown>) };
      if (typeof draft.timestamp !== "string") {
        draft.timestamp = new Date().toISOString();
      }
      const parsed = parseMemoryEvent(draft);
      if (!parsed) {
        return {
          ok: false,
          error:
            "Event failed validation. Check that `kind` and the kind-specific required fields are present.",
        };
      }

      try {
        const result = appendMemoryEvent(repoRoot, parsed as MemoryEvent);
        return { ok: true, written: result.written, rotation: result.rotation ?? null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

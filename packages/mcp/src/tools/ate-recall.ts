/**
 * `mandu_ate_recall` — Phase B.2 memory read tool.
 *
 * See docs/ate/phase-b-spec.md §B.2. Agents call this BEFORE generating
 * a spec so they can reference prior intent / rejected healing history.
 *
 * Snake_case (§11 decision #4). Read-only.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { recallMemory, type MemoryEventKind } from "@mandujs/ate";

export const ateRecallToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_recall",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase B.2 memory recall. Queries the project-local " +
      ".mandu/ate-memory.jsonl append-only log with substring + token-" +
      "overlap scoring (no embeddings). Useful BEFORE generation to see " +
      "previously rejected specs, accepted heals, or intent history for " +
      "the same route. Returns { events, totalMatching }. Default limit 10, " +
      "default sinceDays 90. Filter by kind: intent_history | rejected_spec " +
      "| accepted_healing | rejected_healing | prompt_version_drift | " +
      "boundary_gap_filled | coverage_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root.",
        },
        intent: {
          type: "string",
          description: "Natural-language intent to search (substring + token overlap).",
        },
        route: {
          type: "string",
          description: "Route id or pattern ('api-signup' or '/api/signup').",
        },
        kind: {
          type: "string",
          description: "Filter by event kind.",
        },
        limit: {
          type: "number",
          description: "Max events to return. Default 10.",
        },
        sinceDays: {
          type: "number",
          description: "Drop events older than N days. Default 90.",
        },
      },
      required: ["repoRoot"],
    },
  },
];

export function ateRecallTools(_projectRoot: string) {
  return {
    mandu_ate_recall: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      try {
        const result = recallMemory(repoRoot, {
          intent: typeof args.intent === "string" ? args.intent : undefined,
          route: typeof args.route === "string" ? args.route : undefined,
          kind:
            typeof args.kind === "string"
              ? (args.kind as MemoryEventKind)
              : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          sinceDays: typeof args.sinceDays === "number" ? args.sinceDays : undefined,
        });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * `mandu_ate_oracle_pending` — Phase C.4.
 *
 * List pending semantic oracle entries for agent judgment.
 * Read-only.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { findOraclePending } from "@mandujs/ate";

export const ateOraclePendingToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_oracle_pending",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase C.4 — list pending semantic oracle entries. Returns the most recent " +
      "`status=pending` entries from `.mandu/ate-oracle-queue.jsonl`. Each entry " +
      "carries an assertionId, the spec path, the claim text, and an artifactPath " +
      "pointing to screenshot / DOM captures. The agent reviews these and issues a " +
      "verdict via `mandu_ate_oracle_verdict`. CI never blocks on these — " +
      "expectSemantic is deterministic-non-blocking by default.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: { type: "string", description: "Absolute path to the Mandu project root." },
        limit: { type: "number", description: "Maximum entries to return. Default 20." },
        specPath: { type: "string", description: "Filter to a specific spec file." },
      },
      required: ["repoRoot"],
    },
  },
];

export function ateOraclePendingTools(_projectRoot: string) {
  return {
    mandu_ate_oracle_pending: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      const entries = findOraclePending(repoRoot, {
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        ...(typeof args.specPath === "string" ? { specPath: args.specPath } : {}),
      });
      return { ok: true, count: entries.length, entries };
    },
  };
}

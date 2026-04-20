/**
 * `mandu_ate_oracle_replay` — Phase C.4.
 *
 * Read-only. Return every oracle entry (pending + judged) for a spec
 * path — lets agents review the history of semantic claims for a file
 * before re-issuing similar assertions.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { findOracleEntriesForSpec } from "@mandujs/ate";

export const ateOracleReplayToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_oracle_replay",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase C.4 — replay every oracle verdict (pending + passed + failed) for a " +
      "given spec. Returns the full audit trail sorted newest → oldest. Useful for " +
      "agents reviewing past `failed` verdicts before re-issuing similar semantic " +
      "claims, or for human auditors walking the queue history.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: { type: "string", description: "Absolute path to the Mandu project root." },
        specPath: { type: "string", description: "Spec file path to replay." },
      },
      required: ["repoRoot", "specPath"],
    },
  },
];

export function ateOracleReplayTools(_projectRoot: string) {
  return {
    mandu_ate_oracle_replay: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      const specPath = args.specPath as string | undefined;
      if (!repoRoot) return { ok: false, error: "repoRoot is required" };
      if (!specPath) return { ok: false, error: "specPath is required" };
      const entries = findOracleEntriesForSpec(repoRoot, specPath);
      return { ok: true, count: entries.length, entries };
    },
  };
}

/**
 * `mandu_ate_mutation_report` — Phase C.2.
 *
 * Read the persisted last mutation run and compute an aggregate report:
 * killed / survived / timeout counts, mutationScore, survivors ranked by
 * severity + reason.
 *
 * Read-only. Never spawns a child process.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeMutationReport, loadLastMutationRun } from "@mandujs/ate";

export const ateMutationReportToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_mutation_report",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase C.2 — aggregate the last `mandu_ate_mutate` run into a summary report. " +
      "Returns { totalMutations, killed, survived, timeout, mutationScore, " +
      "survivorsBySeverity, byOperator }. Severity: skip_middleware + " +
      "bypass_validation = high; narrow_type / swap_sibling_type / rename_field = " +
      "medium; everything else = low.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root.",
        },
      },
      required: ["repoRoot"],
    },
  },
];

export function ateMutationReportTools(_projectRoot: string) {
  return {
    mandu_ate_mutation_report: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      const loaded = loadLastMutationRun(repoRoot);
      if (!loaded) {
        return {
          ok: false,
          error:
            "No mutation run found. Run mandu_ate_mutate first — the persisted report lives at .mandu/ate-mutations/last-run.json.",
        };
      }
      const report = computeMutationReport(loaded.results);
      return {
        ok: true,
        targetFile: loaded.targetFile,
        generatedAt: loaded.generatedAt,
        totalGenerated: loaded.totalGenerated,
        report,
      };
    },
  };
}

/**
 * `mandu_ate_mutate` — Phase C.2 contract-semantic mutation runner.
 *
 * Runs up to 9 mutation operators on a single target file and executes
 * the repo's test command against each mutation. Classifies results as
 * killed / survived / timeout / error and persists
 * `.mandu/ate-mutations/last-run.json` for `mandu_ate_mutation_report`.
 *
 * Spec: docs/ate/phase-c-spec.md §C.2.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { runMutations } from "@mandujs/ate";

export const ateMutateToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_mutate",
    annotations: {
      readOnlyHint: false,
    },
    description:
      "Phase C.2 — run contract-semantic mutation testing on a target file. " +
      "9 operators: remove_required_field, narrow_type, widen_enum, flip_nullable, " +
      "rename_field, swap_sibling_type, skip_middleware, early_return, bypass_validation. " +
      "Each mutation is written to the target file, the repo's test command runs " +
      "against it, and the result is classified killed / survived / timeout / error. " +
      "Default cap 50 mutations per invocation; pass `--all` or maxMutations to lift. " +
      "The original file is always restored. Persists .mandu/ate-mutations/last-run.json.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root.",
        },
        targetFile: {
          type: "string",
          description:
            "Absolute or repo-relative path to the file to mutate (contract, handler, or filling).",
        },
        testCommand: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional override for the test command (argv form). Default: resolved from spec-indexer.",
        },
        timeoutMs: {
          type: "number",
          description: "Per-mutation timeout in ms. Default 120000.",
        },
        maxMutations: {
          type: "number",
          description: "Cap on the number of mutations executed. Default 50.",
        },
        operators: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional subset of operator names. Default = all 9. Pass [] to skip execution.",
        },
      },
      required: ["repoRoot", "targetFile"],
    },
  },
];

export function ateMutateTools(_projectRoot: string) {
  return {
    mandu_ate_mutate: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      const targetFile = args.targetFile as string | undefined;
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      if (!targetFile || typeof targetFile !== "string") {
        return { ok: false, error: "targetFile is required" };
      }
      try {
        const result = await runMutations({
          repoRoot,
          targetFile,
          ...(Array.isArray(args.testCommand) ? { testCommand: args.testCommand as string[] } : {}),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          ...(typeof args.maxMutations === "number" ? { maxMutations: args.maxMutations } : {}),
          ...(Array.isArray(args.operators) ? { operators: args.operators as never } : {}),
        });
        return {
          ok: true,
          targetFile: result.targetFile,
          totalGenerated: result.totalGenerated,
          totalExecuted: result.totalExecuted,
          reportPath: result.reportPath,
          results: result.results,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

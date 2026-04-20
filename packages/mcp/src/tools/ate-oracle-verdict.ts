/**
 * `mandu_ate_oracle_verdict` — Phase C.4.
 *
 * Apply an agent / human verdict to a pending oracle entry. Rewrites
 * matching pending rows with `status = passed|failed` + verdict metadata.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { setOracleVerdict } from "@mandujs/ate";

export const ateOracleVerdictToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_oracle_verdict",
    annotations: {
      readOnlyHint: false,
    },
    description:
      "Phase C.4 — record an oracle verdict for a pending semantic assertion. " +
      "`verdict: 'pass' | 'fail'`. `judgedBy`: 'agent' (default) or 'human'. " +
      "`reason` is the short free-form justification the agent (or human) provides. " +
      "Every pending queue entry with the matching assertionId transitions to the " +
      "given verdict — subsequent `promoteVerdicts: true` expectSemantic calls will " +
      "see past `failed` verdicts and throw deterministically.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: { type: "string", description: "Absolute path to the Mandu project root." },
        assertionId: { type: "string", description: "Stable assertion id returned by expectSemantic." },
        verdict: {
          type: "string",
          enum: ["pass", "fail"],
          description: "Whether the agent judges the claim satisfied.",
        },
        reason: { type: "string", description: "Free-form justification." },
        judgedBy: {
          type: "string",
          enum: ["agent", "human"],
          description: "Source of the verdict. Defaults to 'agent'.",
        },
      },
      required: ["repoRoot", "assertionId", "verdict", "reason"],
    },
  },
];

export function ateOracleVerdictTools(_projectRoot: string) {
  return {
    mandu_ate_oracle_verdict: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      const assertionId = args.assertionId as string | undefined;
      const verdict = args.verdict as string | undefined;
      const reason = args.reason as string | undefined;
      const judgedBy = args.judgedBy as string | undefined;
      if (!repoRoot) return { ok: false, error: "repoRoot is required" };
      if (!assertionId) return { ok: false, error: "assertionId is required" };
      if (verdict !== "pass" && verdict !== "fail") {
        return { ok: false, error: "verdict must be 'pass' or 'fail'" };
      }
      if (!reason || typeof reason !== "string") {
        return { ok: false, error: "reason is required" };
      }
      const res = setOracleVerdict(repoRoot, {
        assertionId,
        verdict,
        reason,
        ...(judgedBy === "agent" || judgedBy === "human" ? { judgedBy } : {}),
      });
      return { ok: true, updated: res.updated, entries: res.entries };
    },
  };
}

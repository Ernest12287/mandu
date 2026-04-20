/**
 * `mandu_ate_coverage` — Phase B.4 quantified gap report.
 *
 * See docs/ate/phase-b-spec.md §B.5 for the output shape. Agents call
 * this to discover `topGaps` and prioritize spec generation work.
 *
 * Snake_case (§11 decision #4). Read-only.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { computeCoverage } from "@mandujs/ate";

export const ateCoverageToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_coverage",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase B.4 coverage metrics. Returns the 3-axis coverage report: " +
      "(1) routes with unit / integration / e2e spec; (2) contracts with " +
      "full / partial / no boundary-probe coverage; (3) middleware " +
      "invariants (csrf / rate-limit / session / auth / i18n) tagged as " +
      "covered / partial / missing. Also returns a `topGaps` list sorted " +
      "high → medium → low severity. Stamped with graphVersion for " +
      "agent cache invalidation.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root.",
        },
        scope: {
          type: "string",
          enum: ["project", "route", "contract"],
          description:
            "Default 'project'. Use 'route' (with target=routeId) or 'contract' (with target=contractName) for narrow scans.",
        },
        target: {
          type: "string",
          description: "Route id or contract basename when scope is not 'project'.",
        },
      },
      required: ["repoRoot"],
    },
  },
];

export function ateCoverageTools(_projectRoot: string) {
  return {
    mandu_ate_coverage: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      const scope = args.scope as "project" | "route" | "contract" | undefined;
      const target = typeof args.target === "string" ? args.target : undefined;

      try {
        const metrics = await computeCoverage(repoRoot, {
          scope: scope ?? "project",
          ...(target ? { target } : {}),
        });
        return { ok: true, ...metrics };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

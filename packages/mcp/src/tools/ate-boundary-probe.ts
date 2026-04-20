/**
 * `mandu_ate_boundary_probe` — Phase B.1 deterministic boundary-value
 * generator for Zod contracts.
 *
 * See docs/ate/phase-b-spec.md §B.1 for the full I/O shape. Agents
 * feed the returned probe set into `mandu_ate_prompt({ kind:
 * "property_based" })` to produce adversarial specs.
 *
 * Snake_case tool name (§11 decision #4). Read-only.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { generateBoundaryProbes } from "@mandujs/ate";

export const ateBoundaryProbeToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_boundary_probe",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase B.1 deterministic boundary probe for Zod contracts. Reads a " +
      "*.contract.ts file, parses request-body schemas per HTTP method, and " +
      "returns a deterministic set of probe values per field — one per " +
      "category (valid / invalid_format / boundary_min / boundary_max / " +
      "empty / null / type_mismatch / enum_reject / missing_required). " +
      "Every probe also carries the expectedStatus code derived from the " +
      "contract's response map (400/422 for invalid, 200/201 for valid). " +
      "The output is stamped with graphVersion for agent cache " +
      "invalidation. No LLM. No runtime Zod evaluation — source text is " +
      "parsed directly. Default depth 1, max 3.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root.",
        },
        contractName: {
          type: "string",
          description:
            "Contract identifier. Usually the basename of the contract file (e.g. 'SignupContract' or 'api-signup').",
        },
        contractFile: {
          type: "string",
          description: "Direct absolute path to the contract file (bypasses name resolution).",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "Optional HTTP method filter. Omit to probe every declared method.",
        },
        depth: {
          type: "number",
          description: "Recursion depth for nested z.object() fields. Default 1, max 3.",
        },
      },
      required: ["repoRoot"],
    },
  },
];

export function ateBoundaryProbeTools(_projectRoot: string) {
  return {
    mandu_ate_boundary_probe: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      const contractName = args.contractName as string | undefined;
      const contractFile = args.contractFile as string | undefined;
      const method = args.method as
        | "GET"
        | "POST"
        | "PUT"
        | "PATCH"
        | "DELETE"
        | undefined;
      const depth = typeof args.depth === "number" ? args.depth : undefined;

      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      if (!contractName && !contractFile) {
        return { ok: false, error: "contractName or contractFile is required" };
      }

      try {
        const result = await generateBoundaryProbes({
          repoRoot,
          contractName,
          contractFile,
          ...(method ? { method } : {}),
          ...(depth !== undefined ? { depth } : {}),
        });
        return {
          ok: true,
          contractName: result.contractName,
          contractFile: result.contractFile,
          graphVersion: result.graphVersion,
          probes: result.probes,
          warnings: result.warnings,
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

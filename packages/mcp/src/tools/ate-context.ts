/**
 * `mandu_ate_context` — Phase A.1 agent-native context tool.
 *
 * See `docs/ate/roadmap-v2-agent-native.md` §4.1 for the full design
 * and §11 decision 4 for the naming convention (snake_case).
 *
 * Semantics: return a single JSON blob that an LLM-driven agent
 * (Cursor / Claude Code / Codex) can read *before* generating a test.
 * The blob fuses:
 *
 *   1. Route metadata (pattern, file, isRedirect, static params)
 *   2. Contract surface (request/response schemas + examples)
 *   3. Middleware chain (canonical name + options + file)
 *   4. Guard preset + suggested data-route-id selectors
 *   5. Fixture recommendations (createTestSession, createTestDb, ...)
 *   6. Existing specs (user-written vs ate-generated, last-run status)
 *   7. Related routes (siblings + ui-entry-point pairing)
 *
 * The handler itself is deliberately thin — almost all work is done
 * inside `@mandujs/ate`'s `buildContext` so the same logic is
 * importable from non-MCP callers (CLI, tests).
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ateContext } from "@mandujs/ate";

export const ateContextToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_context",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase A.1 agent-native context. Returns a single JSON blob containing the " +
      "Mandu-specific semantic context an LLM needs to write a correct test: " +
      "route metadata, contract (with examples), middleware chain, guard preset + " +
      "suggested [data-route-id] selectors, recommended @mandujs/core/testing fixtures, " +
      "existing specs (with last-run status when .mandu/ate-last-run.json is present), " +
      "and related routes (sibling + ui-entry-point pairing). " +
      "Scope values: " +
      "'project' = repo summary with route + coverage counts; " +
      "'route' = single-route deep view (requires id or route); " +
      "'filling' = server-handler view with middleware + actions (requires id); " +
      "'contract' = request/response + examples for a contract definition. " +
      "Run mandu.ate.extract first — this tool reads .mandu/interaction-graph.json.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root",
        },
        scope: {
          type: "string",
          enum: ["project", "route", "filling", "contract"],
          description:
            "project (summary) | route (single route deep view) | filling (handler view) | contract (contract definition view)",
        },
        id: {
          type: "string",
          description:
            "Route id ('api-signup'), filling id ('filling:api-signup'), or contract name. Optional — supply id OR route.",
        },
        route: {
          type: "string",
          description:
            "Route pattern match (e.g. '/api/signup'). Optional — supply id OR route.",
        },
      },
      required: ["repoRoot", "scope"],
    },
  },
];

export function ateContextTools(_projectRoot: string) {
  return {
    mandu_ate_context: async (args: Record<string, unknown>) => {
      const { repoRoot, scope, id, route } = args as {
        repoRoot: string;
        scope: "project" | "route" | "filling" | "contract";
        id?: string;
        route?: string;
      };
      // Minimal validation — the MCP SDK already enforces the schema,
      // but we guard repoRoot explicitly so mis-invocations surface a
      // loud error rather than a cascading filesystem failure.
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      if (!scope) {
        return { ok: false, error: "scope is required" };
      }
      const blob = await ateContext({ repoRoot, scope, id, route });
      return { ok: true, context: blob };
    },
  };
}

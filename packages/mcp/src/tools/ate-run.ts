/**
 * `mandu_ate_run` — Phase A.2 agent-facing spec runner.
 *
 * Wraps `@mandujs/ate`'s `runSpec` behind the MCP tool surface.
 *
 * Semantics: execute a single spec file (Playwright or bun:test,
 * auto-detected from the path), then return the failure.v1-shaped
 * JSON — `{ status: "pass", ... }` on green, full failure envelope
 * on red. Shard argument is forwarded transparently.
 *
 * The handler validates the returned shape against the failure.v1
 * Zod schema on failure (cheap, catches translator regressions).
 * On pass we return the pass envelope as-is.
 *
 * Snake_case naming per §11 decision 4.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { runSpec, failureV1Schema, type RunResult } from "@mandujs/ate";

export const ateRunToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_run",
    annotations: {
      readOnlyHint: false,
    },
    description:
      "Phase A.2 agent-native spec runner. Executes ONE spec file " +
      "(Playwright if the path matches tests/e2e/** or *.e2e.ts, otherwise bun:test) " +
      "and returns structured JSON. On pass: { status: 'pass', durationMs, assertions, graphVersion, runId }. " +
      "On fail: a failure.v1 envelope with discriminated `kind` (one of: selector_drift, " +
      "contract_mismatch, redirect_unexpected, hydration_timeout, rate_limit_exceeded, " +
      "csrf_invalid, fixture_missing, semantic_divergence), kind-specific `detail`, " +
      "`healing.auto[]` (deterministic replacements when confidence >= threshold), " +
      "`healing.requires_llm` (true for shape-level failures), `flakeScore`, `lastPassedAt`, " +
      "`graphVersion` (agent cache invalidation key), and trace/screenshot/dom artifacts " +
      "staged under .mandu/ate-artifacts/<runId>/. Use `shard: { current, total }` to " +
      "distribute across CI workers.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root",
        },
        spec: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          ],
          description:
            "Spec file — either a path string (relative to repoRoot) or { path }. " +
            "Runner is auto-detected from the path (Playwright vs bun:test).",
        },
        headed: {
          type: "boolean",
          description: "Playwright only — run headed. Default: false (headless).",
        },
        trace: {
          type: "boolean",
          description: "Playwright only — capture trace. Default: true.",
        },
        shard: {
          type: "object",
          properties: {
            current: { type: "number", minimum: 1 },
            total: { type: "number", minimum: 1 },
          },
          required: ["current", "total"],
          description:
            "CI sharding — `current` is 1-based. Playwright receives --shard=current/total; " +
            "bun:test falls back to hash-based partitioning.",
        },
      },
      required: ["repoRoot", "spec"],
    },
  },
];

export function ateRunTools(_projectRoot: string) {
  return {
    mandu_ate_run: async (args: Record<string, unknown>) => {
      const { repoRoot, spec, headed, trace, shard } = args as {
        repoRoot: string;
        spec: string | { path: string };
        headed?: boolean;
        trace?: boolean;
        shard?: { current: number; total: number };
      };
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      if (!spec) {
        return { ok: false, error: "spec is required" };
      }
      const specPath = typeof spec === "string" ? spec : spec?.path;
      if (!specPath || typeof specPath !== "string") {
        return { ok: false, error: "spec.path or spec string is required" };
      }
      if (shard) {
        if (
          typeof shard.current !== "number" ||
          typeof shard.total !== "number" ||
          shard.current < 1 ||
          shard.total < 1 ||
          shard.current > shard.total
        ) {
          return {
            ok: false,
            error: `invalid shard: ${JSON.stringify(shard)} (current must be 1..total)`,
          };
        }
      }

      let result: RunResult;
      try {
        result = await runSpec({
          repoRoot,
          spec: specPath,
          headed,
          trace,
          shard,
        });
      } catch (err) {
        return {
          ok: false,
          error: `runSpec failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // On failure, re-validate the shape against failure.v1. The
      // runSpec path already does this, but re-checking at the MCP
      // boundary means a buggy translator is caught before the
      // payload crosses the wire.
      if (result.status === "fail") {
        const parsed = failureV1Schema.safeParse(result);
        if (!parsed.success) {
          return {
            ok: false,
            error: `runSpec emitted invalid failure.v1: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
            result,
          };
        }
        return { ok: true, result: parsed.data };
      }
      return { ok: true, result };
    },
  };
}

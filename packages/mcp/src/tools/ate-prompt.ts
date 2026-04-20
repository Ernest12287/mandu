/**
 * `mandu_ate_prompt` — Phase A.3 prompt catalog tool.
 *
 * See `docs/ate/roadmap-v2-agent-native.md` §4.2 and §7 (A.3 extension
 * "Pre-composed prompts") for the design.
 *
 * Semantics:
 *   - If `context` is provided, the handler composes the full prompt
 *     (template + matched exemplars + serialized context) and returns
 *     a single ready-to-send-to-LLM string.
 *   - If `context` is omitted, the handler returns the raw template body +
 *     sha256 + a peek at available exemplars — the agent composes.
 *
 * Snake_case tool name (§11 decision #4). Read-only.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  loadPrompt,
  scanExemplars,
  composePrompt,
  type Exemplar,
} from "@mandujs/ate";

export const atePromptToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_prompt",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase A.3 agent-native prompt catalog. Returns the system prompt for a " +
      "given test kind, with Mandu-specific primitives, anti-patterns, and the " +
      "selector convention baked in. When `context` is passed, the handler " +
      "also injects up-to-3 matching exemplars (tagged with @ate-exemplar:) " +
      "plus the JSON context block and returns a fully composed, ready-to-" +
      "send-to-LLM string. When `context` is omitted, the handler returns the " +
      "raw template + the separate exemplar list so the agent can compose. " +
      "Kinds available in v1: filling_unit, filling_integration, e2e_playwright. " +
      "The returned sha256 is stable per-version and safe as a cache key.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description:
            "Absolute path to the Mandu project root. Required when context is " +
            "omitted so we can scan exemplars from the repo.",
        },
        kind: {
          type: "string",
          description:
            "Prompt kind. v1 catalog: filling_unit | filling_integration | e2e_playwright.",
        },
        version: {
          type: "number",
          description:
            "Pin to a specific template version. Defaults to the highest available.",
        },
        context: {
          type: "object",
          description:
            "Optional semantic context (usually the output of mandu_ate_context). " +
            "When present, the returned `prompt` is pre-composed.",
          additionalProperties: true,
        },
        maxPositive: {
          type: "number",
          description: "Max positive exemplars to inject. Default 3.",
        },
        maxAnti: {
          type: "number",
          description: "Max anti-exemplars to inject. Default 1.",
        },
      },
      required: ["kind"],
    },
  },
];

export function atePromptTools(_projectRoot: string) {
  return {
    mandu_ate_prompt: async (args: Record<string, unknown>) => {
      const kind = args.kind as string | undefined;
      if (!kind || typeof kind !== "string") {
        return { ok: false, error: "'kind' is required and must be a string" };
      }

      const version = typeof args.version === "number" ? args.version : undefined;
      const repoRoot = typeof args.repoRoot === "string" ? args.repoRoot : undefined;
      const context = args.context;
      const maxPositive = typeof args.maxPositive === "number" ? args.maxPositive : undefined;
      const maxAnti = typeof args.maxAnti === "number" ? args.maxAnti : undefined;

      try {
        // When context is given, return a pre-composed prompt.
        if (context !== undefined) {
          const composed = await composePrompt({
            kind,
            version,
            context,
            repoRoot,
            ...(maxPositive !== undefined ? { maxPositive } : {}),
            ...(maxAnti !== undefined ? { maxAnti } : {}),
          });
          return {
            ok: true,
            prompt: composed.prompt,
            sha256: composed.sha256,
            version: composed.version,
            kind: composed.kind,
            exemplarCount: composed.exemplarCount,
            antiCount: composed.antiCount,
            tokenEstimate: composed.tokenEstimate,
          };
        }

        // Otherwise: raw template + exemplar peek so the agent composes.
        const loaded = loadPrompt(kind, version);
        let exemplars: Exemplar[] = [];
        if (repoRoot) {
          try {
            const all = await scanExemplars(repoRoot);
            exemplars = all.filter((e) => e.kind === kind).slice(0, 5);
          } catch {
            // non-fatal — caller may invoke without a repoRoot
          }
        }
        return {
          ok: true,
          prompt: loaded.raw,
          sha256: loaded.sha256,
          version: loaded.frontmatter.version,
          kind: loaded.frontmatter.kind,
          exemplars,
          exemplarCount: exemplars.filter((e) => !e.anti).length,
          antiCount: exemplars.filter((e) => e.anti).length,
          tokenEstimate: Math.ceil(loaded.raw.length / 4),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  };
}

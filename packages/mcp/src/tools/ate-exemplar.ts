/**
 * `mandu_ate_exemplar` — Phase A.3 exemplar browser.
 *
 * See `docs/ate/roadmap-v2-agent-native.md` §4.3. Returns the
 * `@ate-exemplar:` tagged tests for a given kind so an agent can
 * few-shot against them without paying the "compose the whole prompt"
 * token cost.
 *
 * Snake_case tool name (§11 decision #4). Read-only.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { scanExemplars, type Exemplar } from "@mandujs/ate";

export const ateExemplarToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_exemplar",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase A.3 agent-native exemplar browser. Returns up to `limit` tests " +
      "tagged with `@ate-exemplar: kind=<kind>` from the repo. Each entry " +
      "carries the file path, start/end line, tags, and the full source of the " +
      "test() / it() / describe() call that follows the tag. Set " +
      "includeAnti:true to also surface `@ate-exemplar-anti:` (DO-NOT-do-this) " +
      "cases. Exemplars are manually curated (roadmap §11 decision 2) — no " +
      "auto-heuristic. Use this when you want few-shot examples without paying " +
      "for the full composed prompt.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root.",
        },
        kind: {
          type: "string",
          description:
            "Match against the tag's `kind=` attribute. Examples: filling_unit, filling_integration, e2e_playwright.",
        },
        limit: {
          type: "number",
          description: "Max entries to return. Default 5.",
        },
        includeAnti: {
          type: "boolean",
          description:
            "Also include @ate-exemplar-anti markers (default false — only positive exemplars).",
        },
      },
      required: ["repoRoot", "kind"],
    },
  },
];

export function ateExemplarTools(_projectRoot: string) {
  return {
    mandu_ate_exemplar: async (args: Record<string, unknown>) => {
      const repoRoot = args.repoRoot as string | undefined;
      const kind = args.kind as string | undefined;
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const includeAnti = args.includeAnti === true;

      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "'repoRoot' is required" };
      }
      if (!kind || typeof kind !== "string") {
        return { ok: false, error: "'kind' is required" };
      }

      try {
        const all = await scanExemplars(repoRoot);
        const filtered = all.filter((e) => e.kind === kind);
        const selected: Exemplar[] = [];
        const positives = filtered.filter((e) => !e.anti).slice(0, limit);
        selected.push(...positives);
        if (includeAnti) {
          // Reserve up to half the limit for antis so positives aren't crowded out.
          const antiBudget = Math.max(1, Math.floor(limit / 2));
          const antis = filtered.filter((e) => e.anti).slice(0, antiBudget);
          selected.push(...antis);
        }

        return { ok: true, exemplars: selected, total: filtered.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  };
}

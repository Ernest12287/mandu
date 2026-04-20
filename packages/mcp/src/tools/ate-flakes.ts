/**
 * `mandu_ate_flakes` — Phase A.2 flake detector surface.
 *
 * Returns every spec whose rolling pass/fail transition ratio exceeds
 * `minScore` (default 0.1) within the last `windowSize` runs
 * (default 20). Agents use this to prioritize stabilization work.
 *
 * Data source: `.mandu/ate-run-history.jsonl`, appended to by
 * `runSpec`. When no history is present we return an empty array —
 * not an error.
 *
 * Snake_case naming per §11 decision 4.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { summarizeFlakes } from "@mandujs/ate";

export const ateFlakesToolDefinitions: Tool[] = [
  {
    name: "mandu_ate_flakes",
    annotations: {
      readOnlyHint: true,
    },
    description:
      "Phase A.2 flake detector. Reads `.mandu/ate-run-history.jsonl` and returns specs " +
      "whose pass/fail status flips often within the rolling window. `flakeScore` = " +
      "status_transitions / (N - 1) over last `windowSize` non-skipped runs. " +
      "Pure-pass PPPPP = 0.0 (stable), pure-fail FFFFF = 0.0 (broken, NOT flaky), " +
      "alternating PFPF = 1.0. Returns an empty list when history is empty or no spec " +
      "clears `minScore`. Use this to prioritize which flaky tests to fix first — feed " +
      "a specPath from the result into mandu_ate_run for a re-run + full failure.v1 " +
      "diagnostic.",
    inputSchema: {
      type: "object",
      properties: {
        repoRoot: {
          type: "string",
          description: "Absolute path to the Mandu project root",
        },
        windowSize: {
          type: "number",
          minimum: 2,
          description: "Rolling window size. Default: 20.",
        },
        minScore: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Filter threshold for flakeScore. Default: 0.1.",
        },
      },
      required: ["repoRoot"],
    },
  },
];

export function ateFlakesTools(_projectRoot: string) {
  return {
    mandu_ate_flakes: async (args: Record<string, unknown>) => {
      const { repoRoot, windowSize, minScore } = args as {
        repoRoot: string;
        windowSize?: number;
        minScore?: number;
      };
      if (!repoRoot || typeof repoRoot !== "string") {
        return { ok: false, error: "repoRoot is required" };
      }
      if (typeof windowSize === "number" && windowSize < 2) {
        return { ok: false, error: "windowSize must be >= 2" };
      }
      if (
        typeof minScore === "number" &&
        (minScore < 0 || minScore > 1 || !Number.isFinite(minScore))
      ) {
        return { ok: false, error: "minScore must be in [0, 1]" };
      }
      try {
        const flakyTests = summarizeFlakes(repoRoot, {
          windowSize,
          minScore,
        });
        return { ok: true, flakyTests };
      } catch (err) {
        return {
          ok: false,
          error: `summarizeFlakes failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

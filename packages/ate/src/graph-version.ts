/**
 * graph-version — deterministic freshness hash for agent cache
 * invalidation.
 *
 * Per the 2026-04-21 boost block in §7 of the roadmap, every context
 * response and every failure JSON must carry a `graphVersion` string
 * so that an agent can detect when its cached Mandu context is stale.
 *
 * Hash input:
 *   - sorted list of route ids
 *   - sorted list of contract ids (inferredRoute values + file names)
 *   - extractor version string (bumped whenever the extractor output
 *     shape changes in a way that affects context consumers)
 *
 * We intentionally use node:crypto's `createHash` here — `Bun.hash`
 * is available in-process but produces a different digest than the
 * one a sibling tool (e.g. CI verifying `graphVersion`) would get
 * without Bun. Determinism across Bun / Node / stringification is
 * the priority; this is not a perf-hot path.
 */
import { createHash } from "node:crypto";
import type { InteractionGraph } from "./types";

/**
 * Bump whenever the **shape** of the extractor output changes in a
 * way downstream agents care about. Incremental route additions do
 * not require a bump — only changes to what is emitted per node.
 */
export const EXTRACTOR_VERSION = "phase-a-2.1";

export interface GraphVersionInput {
  routeIds: string[];
  contractIds: string[];
  extractorVersion?: string;
}

/**
 * Compute the canonical `graphVersion` string.
 *
 * The input is normalized by:
 *   1. de-duplicating each list
 *   2. sorting ascending
 *   3. joining with a `|` separator on each list, and the two lists
 *      with `\x1f` (ASCII unit separator) between them
 *   4. appending the extractor version
 *
 * The output is the hex sha256 digest, prefixed with `gv1:` so
 * future format bumps can coexist with current hashes in cached
 * agent memory.
 */
export function computeGraphVersion(input: GraphVersionInput): string {
  const normalize = (xs: string[]) =>
    [...new Set(xs)].map((s) => s.trim()).filter(Boolean).sort();

  const routePart = normalize(input.routeIds).join("|");
  const contractPart = normalize(input.contractIds).join("|");
  const ev = input.extractorVersion ?? EXTRACTOR_VERSION;

  const payload = `${routePart}\x1f${contractPart}\x1f${ev}`;
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `gv1:${digest.slice(0, 32)}`;
}

/**
 * Convenience — pull the required lists out of an extractor graph
 * and hash them. When `graph` is null (extractor hasn't run yet)
 * a sentinel `gv1:unknown` is returned so downstream code can still
 * emit a deterministic string.
 */
export function graphVersionFromGraph(graph: InteractionGraph | null): string {
  if (!graph) return "gv1:unknown";
  const routeIds: string[] = [];
  const contractIds: string[] = [];
  for (const node of graph.nodes) {
    if (node.kind === "route") {
      // Prefer the normalized `routeId` when present; fall back to id.
      routeIds.push(node.routeId ?? node.id);
      if (node.hasContract) {
        // The extractor doesn't emit the contract file path on the
        // route node, but the inferred route is stable enough for
        // the hash — contract_parser derives it from the route path.
        contractIds.push(`contract:${node.path}`);
      }
    }
  }
  return computeGraphVersion({ routeIds, contractIds });
}

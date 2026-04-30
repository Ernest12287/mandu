/**
 * Plan a deploy — compute the next `DeployIntentCache` from a
 * manifest and the previous cache.
 *
 * Issue #250 — Phase 1.
 *
 * The plan step is pure: it takes the manifest + previous cache +
 * inferer and returns the new cache + a diff. No filesystem writes
 * here; that's the CLI's job. Keeping this pure makes the diff easy
 * to render in tests and lets future surfaces (kitchen UI, MCP tool)
 * reuse the same plan logic.
 *
 * Override hierarchy (highest wins):
 *
 *   1. **Explicit** — entry where `source === "explicit"` in the
 *      previous cache. Never overwritten by inference. Re-keyed by
 *      `sourceHash` only so users can hand-edit the file and have
 *      their edits stick.
 *   2. **Cached, source unchanged** — same `sourceHash` ⇒ reuse the
 *      stored intent. This is the cost cap on brain calls.
 *   3. **Inferred** — call the inferer. Default is heuristic; brain
 *      can swap in via the `infer` parameter.
 */

import type { RoutesManifest } from "../spec/schema";
import {
  emptyDeployIntentCache,
  type DeployIntentCache,
  type DeployIntentCacheEntry,
} from "./cache";
import { buildDeployInferenceContext, type DeployInferenceContext } from "./inference/context";
import {
  inferDeployIntentHeuristic,
  type InferenceResult,
} from "./inference/heuristic";

/**
 * Per-route diff entry surfaced to the CLI / tests.
 *
 *   - `added`     — no prior entry, new intent inferred.
 *   - `unchanged` — same source hash; entry kept verbatim.
 *   - `changed`   — source hash differs OR explicit override updated;
 *                   the `previous` field carries the old entry for
 *                   diff rendering.
 *   - `removed`   — route exists in cache but not in manifest. Pruned.
 *   - `pinned`    — explicit entry; inference skipped.
 */
export type PlanDiffEntryKind =
  | "added"
  | "unchanged"
  | "changed"
  | "removed"
  | "pinned";

export interface PlanDiffEntry {
  routeId: string;
  pattern: string;
  kind: PlanDiffEntryKind;
  next?: DeployIntentCacheEntry;
  previous?: DeployIntentCacheEntry;
}

export interface PlanResult {
  cache: DeployIntentCache;
  diff: PlanDiffEntry[];
}

export interface PlanDeployOptions {
  rootDir: string;
  manifest: RoutesManifest;
  previous?: DeployIntentCache;
  /**
   * Override the inferer. Defaults to the offline heuristic. The
   * brain inferer (M4) plugs in here without changing the plan flow.
   */
  infer?: (ctx: DeployInferenceContext) => Promise<InferenceResult> | InferenceResult;
  /** Identifier written into `cache.brainModel`. Defaults to `"heuristic"`. */
  brainModel?: string;
  /** ISO timestamp override — primarily for test determinism. */
  now?: () => string;
  /** Force re-inference even when the source hash matches. */
  reinfer?: boolean;
}

export async function planDeploy(opts: PlanDeployOptions): Promise<PlanResult> {
  const previous = opts.previous ?? emptyDeployIntentCache();
  const infer =
    opts.infer ?? ((ctx: DeployInferenceContext) => inferDeployIntentHeuristic(ctx));
  const now = opts.now ?? (() => new Date().toISOString());
  const brainModel = opts.brainModel ?? "heuristic";
  const reinfer = opts.reinfer === true;

  const nextIntents: Record<string, DeployIntentCacheEntry> = {};
  const diff: PlanDiffEntry[] = [];

  for (const route of opts.manifest.routes) {
    const ctx = await buildDeployInferenceContext(opts.rootDir, route);
    const prevEntry = previous.intents[route.id];

    // 1. Explicit override — never re-infer; only refresh sourceHash.
    if (prevEntry && prevEntry.source === "explicit") {
      const refreshed: DeployIntentCacheEntry = {
        ...prevEntry,
        sourceHash: ctx.sourceHash,
      };
      nextIntents[route.id] = refreshed;
      diff.push({
        routeId: route.id,
        pattern: route.pattern,
        kind: "pinned",
        next: refreshed,
        previous: prevEntry,
      });
      continue;
    }

    // 2. Cached, source unchanged.
    if (
      !reinfer &&
      prevEntry &&
      prevEntry.sourceHash === ctx.sourceHash
    ) {
      nextIntents[route.id] = prevEntry;
      diff.push({
        routeId: route.id,
        pattern: route.pattern,
        kind: "unchanged",
        next: prevEntry,
        previous: prevEntry,
      });
      continue;
    }

    // 3. Infer.
    const result = await infer(ctx);
    const entry: DeployIntentCacheEntry = {
      intent: result.intent,
      source: "inferred",
      rationale: result.rationale,
      sourceHash: ctx.sourceHash,
      inferredAt: now(),
    };
    nextIntents[route.id] = entry;
    diff.push({
      routeId: route.id,
      pattern: route.pattern,
      kind: prevEntry ? "changed" : "added",
      next: entry,
      previous: prevEntry,
    });
  }

  // 4. Detect removed entries (cache had them, manifest doesn't).
  const manifestIds = new Set(opts.manifest.routes.map((r) => r.id));
  for (const [routeId, entry] of Object.entries(previous.intents)) {
    if (manifestIds.has(routeId)) continue;
    diff.push({
      routeId,
      pattern: "(removed from manifest)",
      kind: "removed",
      previous: entry,
    });
  }

  const cache: DeployIntentCache = {
    version: 1,
    generatedAt: now(),
    brainModel,
    intents: nextIntents,
  };

  return { cache, diff };
}

/** True if the diff contains any non-`unchanged` entry. */
export function planHasChanges(diff: readonly PlanDiffEntry[]): boolean {
  return diff.some((d) => d.kind !== "unchanged" && d.kind !== "pinned");
}

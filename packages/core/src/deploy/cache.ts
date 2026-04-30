/**
 * Deploy intent cache — `.mandu/deploy.intent.json`.
 *
 * Issue #250 — Phase 1.
 *
 * The cache is the persistence layer between `mandu deploy:plan`
 * (writer) and `mandu deploy --target=...` (reader). It MUST be
 * checked into the repo so deploys are deterministic, brain-free, and
 * reproducible across CI runs.
 *
 * Per-entry shape:
 *
 *   - `intent`     — fully validated `DeployIntent`.
 *   - `source`     — `"explicit"` (user wrote `.deploy()` on the
 *                    route) or `"inferred"` (heuristic / brain).
 *                    Explicit entries are never overwritten by
 *                    `deploy:plan` — the inferer treats them as
 *                    pinned ground truth.
 *   - `rationale`  — short, human-readable reason. The plan command
 *                    surfaces this in the diff so reviewers can audit
 *                    why a route landed on a given runtime.
 *   - `sourceHash` — content hash of the route source the intent was
 *                    inferred from. The next plan call skips
 *                    re-inference when the hash matches — that's the
 *                    cost cap on brain calls.
 *   - `inferredAt` — ISO timestamp; left unset on `explicit` entries.
 */

import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { DeployIntent } from "./intent";

export const DeployIntentSource = z.enum(["explicit", "inferred"]);
export type DeployIntentSource = z.infer<typeof DeployIntentSource>;

export const DeployIntentCacheEntry = z.object({
  intent: DeployIntent,
  source: DeployIntentSource,
  rationale: z.string().min(1),
  sourceHash: z.string().min(1),
  inferredAt: z.string().datetime().optional(),
});
export type DeployIntentCacheEntry = z.infer<typeof DeployIntentCacheEntry>;

export const DeployIntentCache = z.object({
  /** Format version — bump on any breaking schema change. */
  version: z.literal(1),
  /** ISO timestamp of the most recent `deploy:plan` write. */
  generatedAt: z.string().datetime(),
  /**
   * Identifier of the inferer used for the most recent write. Examples:
   *   - `"heuristic"`              — rule-tree only (no brain).
   *   - `"openai:gpt-4.1-mini"`    — brain-validated.
   *   - `"manual"`                 — user hand-edited entries.
   */
  brainModel: z.string().min(1).default("heuristic"),
  /** Map of route id → cache entry. */
  intents: z.record(z.string(), DeployIntentCacheEntry),
});
export type DeployIntentCache = z.infer<typeof DeployIntentCache>;

/** Filename relative to the project root. */
export const DEPLOY_INTENT_CACHE_FILE = ".mandu/deploy.intent.json";

/** Resolve the absolute path of the cache file for a given project root. */
export function resolveDeployIntentCachePath(rootDir: string): string {
  return path.join(rootDir, DEPLOY_INTENT_CACHE_FILE);
}

/**
 * An empty (but valid) cache. Returned by `loadDeployIntentCache`
 * when the file is missing — the caller treats that as "every route
 * needs inference".
 */
export function emptyDeployIntentCache(): DeployIntentCache {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    brainModel: "heuristic",
    intents: {},
  };
}

/**
 * Read + validate the cache file. A missing file resolves to an empty
 * cache so first-time runs work without ceremony. A malformed file
 * rejects — silently swallowing JSON errors would let a corrupted
 * cache silently produce wrong deploy configs.
 */
export async function loadDeployIntentCache(
  rootDir: string,
): Promise<DeployIntentCache> {
  const file = resolveDeployIntentCachePath(rootDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyDeployIntentCache();
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Deploy intent cache is not valid JSON (${file}): ${(err as Error).message}`,
    );
  }
  return DeployIntentCache.parse(parsed);
}

/**
 * Atomically write the cache. The intermediate `.tmp` file + rename
 * dance prevents a half-written cache from being read by a concurrent
 * deploy.
 */
export async function saveDeployIntentCache(
  rootDir: string,
  cache: DeployIntentCache,
): Promise<void> {
  const validated = DeployIntentCache.parse(cache);
  const file = resolveDeployIntentCachePath(rootDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // Stable key order so the committed file stays diff-friendly.
  const ordered: DeployIntentCache = {
    ...validated,
    intents: Object.fromEntries(
      Object.keys(validated.intents)
        .sort()
        .map((id) => [id, validated.intents[id]!]),
    ),
  };
  await fs.writeFile(tmp, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

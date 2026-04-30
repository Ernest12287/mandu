/**
 * Build-time extractor for `.deploy()` intents on `Mandu.filling()`
 * route modules.
 *
 * Issue #250 M5. Bridges the runtime DSL (filling.deploy) and the
 * build-time cache (`.mandu/deploy.intent.json`):
 *
 *   1. For every route in the manifest, dynamically `import()` the
 *      module file.
 *   2. If the default export looks like a `ManduFilling` instance and
 *      its `getDeployIntent()` returns a non-null value, capture it
 *      as a Zod-validated `DeployIntent`.
 *   3. The CLI / MCP merges captured entries into the previous cache
 *      with `source: "explicit"` BEFORE calling `planDeploy()` —
 *      explicit entries are protected from inference (M1) so the
 *      user's `.deploy()` always wins.
 *
 * Failure modes (non-fatal — extractor returns the offending route in
 * `errors[]`, planner falls back to inference for it):
 *
 *   - Module file cannot be imported (syntax error, missing dep).
 *   - Default export is not a filling instance.
 *   - `.deploy({...})` payload fails Zod validation (this throws at
 *     module load, so the import error path catches it).
 *
 * The extractor uses dynamic import rather than AST parsing because
 * the manifest is built by importing routes anyway (for static
 * params, slot metadata, etc.) — adding another loader would
 * duplicate work. Side effects in route modules ARE a concern, but
 * Mandu's convention is to put side effects in `loader()` / `get()`
 * callbacks (which the extractor never invokes).
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { DeployIntent, type DeployIntent as DeployIntentType } from "../intent";
import type { RoutesManifest, RouteSpec } from "../../spec/schema";

export interface ExplicitIntentEntry {
  routeId: string;
  pattern: string;
  /** Fully-validated, defaults-applied intent. */
  intent: DeployIntentType;
}

export interface ExplicitIntentError {
  routeId: string;
  pattern: string;
  module: string;
  reason: string;
}

export interface ExtractExplicitIntentsResult {
  entries: ExplicitIntentEntry[];
  errors: ExplicitIntentError[];
}

export interface ExtractExplicitIntentsOptions {
  /**
   * Override the dynamic import for tests. Receives the absolute file
   * URL the extractor would have imported and returns whatever module
   * shape the test wants to inject.
   */
  importer?: (fileUrl: string) => Promise<unknown>;
  /**
   * Skip routes whose modules don't exist on disk. Default `true` —
   * a missing route is a manifest staleness issue, not an extractor
   * concern.
   */
  skipMissing?: boolean;
}

/**
 * Walk the manifest, import each route, and capture explicit deploy
 * intents from `Mandu.filling().deploy({...})` declarations.
 */
export async function extractExplicitIntents(
  rootDir: string,
  manifest: RoutesManifest,
  options: ExtractExplicitIntentsOptions = {},
): Promise<ExtractExplicitIntentsResult> {
  const importer = options.importer ?? defaultImporter;
  const skipMissing = options.skipMissing ?? true;
  const entries: ExplicitIntentEntry[] = [];
  const errors: ExplicitIntentError[] = [];

  for (const route of manifest.routes) {
    const modulePath = path.resolve(rootDir, route.module);
    if (skipMissing) {
      const exists = await pathExists(modulePath);
      if (!exists) continue;
    }

    let mod: unknown;
    try {
      const url = pathToFileURL(modulePath).href;
      mod = await importer(url);
    } catch (err) {
      errors.push({
        routeId: route.id,
        pattern: route.pattern,
        module: route.module,
        reason: `import failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const filling = pickDefaultFilling(mod);
    if (!filling) continue;

    let raw: unknown;
    try {
      raw = filling.getDeployIntent();
    } catch (err) {
      errors.push({
        routeId: route.id,
        pattern: route.pattern,
        module: route.module,
        reason: `getDeployIntent threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (raw === undefined || raw === null) continue;

    // Validate + apply schema defaults so downstream code (cache,
    // adapters) never sees half-typed shapes.
    const parsed = DeployIntent.safeParse(raw);
    if (!parsed.success) {
      errors.push({
        routeId: route.id,
        pattern: route.pattern,
        module: route.module,
        reason: `.deploy() validation failed: ${parsed.error.errors.map((e) => e.message).join("; ")}`,
      });
      continue;
    }

    entries.push({
      routeId: route.id,
      pattern: route.pattern,
      intent: parsed.data,
    });
  }

  return { entries, errors };
}

// ─── Internals ────────────────────────────────────────────────────────

/**
 * Loose duck-type check for ManduFilling. We can't `instanceof`
 * because the imported module's `ManduFilling` constructor may not be
 * the one this package was bundled with (workspace symlinks, package
 * upgrades, etc.). Instead, we look for the public `getDeployIntent`
 * method that ships in the same release as `.deploy()` — versions
 * without the M5 method silently no-op (no entry captured).
 */
type FillingLike = { getDeployIntent: () => unknown };

function isFillingLike(value: unknown): value is FillingLike {
  return (
    value != null &&
    typeof value === "object" &&
    "getDeployIntent" in value &&
    typeof (value as { getDeployIntent: unknown }).getDeployIntent === "function"
  );
}

function pickDefaultFilling(mod: unknown): FillingLike | null {
  if (!mod || typeof mod !== "object") return null;
  const candidate = (mod as { default?: unknown }).default;
  return isFillingLike(candidate) ? candidate : null;
}

async function defaultImporter(fileUrl: string): Promise<unknown> {
  return await import(fileUrl);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Cache merge helper ───────────────────────────────────────────────

import type { DeployIntentCache, DeployIntentCacheEntry } from "../cache";
import { hashSource } from "./context";

/**
 * Merge extractor entries into a cache, marking each one as
 * `source: "explicit"`. Existing entries with the same route id are
 * overwritten — the user's `.deploy()` always wins.
 *
 * `sourceHash` is set from the file's current bytes so the planner
 * can detect drift between the cached intent and the live source.
 * The cache's `generatedAt` and `brainModel` are left untouched so
 * the merge step doesn't pretend to be a re-plan.
 */
export async function mergeExplicitIntents(
  cache: DeployIntentCache,
  entries: ReadonlyArray<ExplicitIntentEntry>,
  rootDir: string,
  manifest: RoutesManifest,
): Promise<DeployIntentCache> {
  if (entries.length === 0) return cache;
  const next: DeployIntentCache = {
    ...cache,
    intents: { ...cache.intents },
  };
  const routeById = new Map<string, RouteSpec>(
    manifest.routes.map((r) => [r.id, r]),
  );

  for (const entry of entries) {
    const route = routeById.get(entry.routeId);
    if (!route) continue;
    const modulePath = path.resolve(rootDir, route.module);
    let source = "";
    try {
      source = await fs.readFile(modulePath, "utf8");
    } catch {
      // Route file vanished between extraction and merge — keep
      // going with an empty hash; the planner will catch the
      // missing-source case on its own.
    }
    const cacheEntry: DeployIntentCacheEntry = {
      intent: entry.intent,
      source: "explicit",
      rationale:
        cache.intents[entry.routeId]?.source === "explicit"
          ? cache.intents[entry.routeId]?.rationale ?? "explicit .deploy() override"
          : "explicit .deploy() override",
      sourceHash: hashSource(source),
    };
    next.intents[entry.routeId] = cacheEntry;
  }

  return next;
}

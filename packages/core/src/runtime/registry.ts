/**
 * Runtime manifest registry.
 *
 * This module provides the **official** accessor for generated content at
 * runtime. User code must NEVER `import` anything under `.mandu/generated/`
 * or any path containing `/generated/` — the guard rule
 * `INVALID_GENERATED_IMPORT` catches that at build time.
 *
 * Why the indirection?
 *
 * - **Hot reload** — in dev, generated modules are rebuilt and re-imported.
 *   A direct ESM import caches the first version; the registry re-reads the
 *   current manifest on every access.
 * - **Determinism** — compiled binaries (`bun build --compile`) embed a
 *   fixed manifest. Direct imports would bypass the embedded copy and fail.
 * - **ESM cache invalidation** — see #184. Transitive generated modules get
 *   stuck on stale copies when hot-reload fires; the registry's `getManifest`
 *   is the single choke point that the bundled importer invalidates cleanly.
 *
 * @see https://mandujs.com/docs/architect/generated-access
 */
import type { RoutesManifest, RouteSpec } from "../spec/schema";

// ═══════════════════════════════════════════════════════════════════════════
// Generated artifact map
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Map of generated artifacts keyed by well-known names.
 *
 * Extend this interface (via module augmentation) in consumers that emit
 * their own generated artifacts — collections, resources, db schemas, etc.
 *
 * @example Module augmentation
 * ```ts
 * declare module "@mandujs/core/runtime" {
 *   interface GeneratedRegistry {
 *     collections: Record<string, CollectionIndex>;
 *   }
 * }
 * ```
 */
export interface GeneratedRegistry {
  /** Route manifest — the single source of truth for page/API routes. */
  routes: RoutesManifest;
}

/** Union of well-known generated artifact keys. */
export type GeneratedKey = keyof GeneratedRegistry;

/** Typed accessor — narrows the return shape from the key. */
export type GeneratedShape<K extends GeneratedKey> = GeneratedRegistry[K];

// ═══════════════════════════════════════════════════════════════════════════
// Global registry state
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The live manifest, populated by `registerManifest()` (typically driven by
 * `registerManifestHandlers()` from `@mandujs/cli`). Kept on `globalThis`
 * so reloading the core module in dev does not lose registration.
 */
declare global {
  // eslint-disable-next-line no-var
  var __MANDU_MANIFEST__: Partial<GeneratedRegistry> | undefined;
}

function ensureGlobalSlot(): Partial<GeneratedRegistry> {
  if (!globalThis.__MANDU_MANIFEST__) {
    globalThis.__MANDU_MANIFEST__ = {};
  }
  return globalThis.__MANDU_MANIFEST__;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register a generated artifact under a well-known key.
 *
 * Called by the framework (typically from `registerManifestHandlers()` in
 * `@mandujs/cli`) during server boot. User code normally does not call this
 * directly — the only exception is tests that want to seed a manifest.
 *
 * @example Test setup
 * ```ts
 * import { registerManifest, clearGeneratedRegistry } from "@mandujs/core/runtime";
 *
 * beforeEach(() => clearGeneratedRegistry());
 * registerManifest("routes", { version: 1, routes: [] });
 * ```
 */
export function registerManifest<K extends GeneratedKey>(
  key: K,
  value: GeneratedShape<K>,
): void {
  const slot = ensureGlobalSlot();
  slot[key] = value;
}

/**
 * Read a generated artifact by key. Throws a helpful error if the manifest
 * has not been registered yet — this almost always means the server boot
 * skipped `registerManifestHandlers()` or the test forgot to seed fixtures.
 *
 * @example Reading the route manifest
 * ```ts
 * import { getGenerated } from "@mandujs/core/runtime";
 *
 * const manifest = getGenerated("routes");
 * for (const route of manifest.routes) {
 *   console.log(route.id, route.pattern);
 * }
 * ```
 *
 * @throws {Error} when the key has not been registered
 */
export function getGenerated<K extends GeneratedKey>(key: K): GeneratedShape<K> {
  const slot = globalThis.__MANDU_MANIFEST__;
  if (!slot || !(key in slot) || slot[key] === undefined) {
    throw new Error(
      `[Mandu] Generated artifact "${String(key)}" not registered. ` +
        `Call registerManifestHandlers() during server boot, or seed the ` +
        `manifest with registerManifest("${String(key)}", …) in tests. ` +
        `See https://mandujs.com/docs/architect/generated-access`,
    );
  }
  return slot[key] as GeneratedShape<K>;
}

/**
 * Return the registered artifact, or `undefined` if absent. Prefer
 * `getGenerated()` for the common case — this variant exists for hot paths
 * where absence is not an error (e.g., optional collections).
 */
export function tryGetGenerated<K extends GeneratedKey>(
  key: K,
): GeneratedShape<K> | undefined {
  const slot = globalThis.__MANDU_MANIFEST__;
  return slot?.[key] as GeneratedShape<K> | undefined;
}

/**
 * Return the full routes manifest. Thin wrapper around `getGenerated("routes")`
 * kept for call-site readability.
 *
 * @throws {Error} when no manifest has been registered yet
 */
export function getManifest(): RoutesManifest {
  return getGenerated("routes");
}

/**
 * Find a single route by its stable ID. Returns `undefined` if no match.
 * Use this instead of `manifest.routes.find(…)` at call sites that already
 * want the readability of a named helper.
 */
export function getRouteById(id: string): RouteSpec | undefined {
  const manifest = tryGetGenerated("routes");
  if (!manifest) return undefined;
  return manifest.routes.find((route) => route.id === id);
}

/**
 * Clear all registered artifacts. Test-only — production code should never
 * call this.
 */
export function clearGeneratedRegistry(): void {
  globalThis.__MANDU_MANIFEST__ = {};
}

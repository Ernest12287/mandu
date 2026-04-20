/**
 * Phase 18.ζ — ISR + cache-tags regression suite.
 *
 * Covers the `packages/core/src/runtime/cache.ts` surface end-to-end:
 *
 *   1. Shape invariants        — createCacheEntry + accepted overloads
 *   2. Lookup semantics        — HIT / STALE / MISS with SWR window
 *   3. LRU bounds              — eviction order + `touch()` on HIT
 *   4. Tag invalidation        — single, multi-tag, cross-tag indices
 *   5. Path invalidation       — routeId:/path?query key parsing
 *   6. revalidate() / revalidateTag() API
 *   7. Cache-Control header    — public, max-age, stale-while-revalidate
 *   8. X-Mandu-Cache header    — HIT / STALE / MISS debug tag
 *   9. Config-driven factory   — createCacheStoreFromConfig surface
 *
 * The suite is hermetic: every test constructs its own MemoryCacheStore
 * so there is no shared mutable state between cases, and the
 * global-cache singleton is reset in `beforeEach`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  MemoryCacheStore,
  lookupCache,
  createCacheEntry,
  createCachedResponse,
  computeCacheControl,
  createCacheStoreFromConfig,
  setGlobalCache,
  setGlobalCacheDefaults,
  getGlobalCacheDefaults,
  revalidate,
  revalidateTag,
  revalidatePath,
  getCacheStoreStats,
  type CacheEntry,
  type CacheStore,
} from "../../src/runtime/cache";

describe("Phase 18.ζ — cache.ts", () => {
  beforeEach(() => {
    // Reset the module-level global caches between tests so one test's
    // store / defaults can't leak into the next.
    setGlobalCache(null as unknown as CacheStore);
    setGlobalCacheDefaults(null);
  });

  // ─── 1. createCacheEntry ───────────────────────────────────────────────

  it("createCacheEntry: legacy positional signature still works", () => {
    const entry = createCacheEntry("<p>ok</p>", { n: 1 }, 60, ["t1"], 200, { "X-Foo": "1" });
    expect(entry.html).toBe("<p>ok</p>");
    expect(entry.loaderData).toEqual({ n: 1 });
    expect(entry.status).toBe(200);
    expect(entry.headers["X-Foo"]).toBe("1");
    expect(entry.tags).toEqual(["t1"]);
    expect(entry.maxAgeSeconds).toBe(60);
    expect(entry.swrSeconds).toBe(0);
    // Without SWR, staleUntil === revalidateAfter
    expect(entry.staleUntil).toBe(entry.revalidateAfter);
  });

  it("createCacheEntry: metadata-object signature extracts maxAge + swr + tags", () => {
    const entry = createCacheEntry(
      "<p>x</p>",
      null,
      { maxAge: 30, staleWhileRevalidate: 120, tags: ["a", "b"] }
    );
    expect(entry.maxAgeSeconds).toBe(30);
    expect(entry.swrSeconds).toBe(120);
    expect(entry.tags).toEqual(["a", "b"]);
    expect(entry.staleUntil).toBe(entry.revalidateAfter + 120_000);
  });

  it("createCacheEntry: `revalidate` + `swr` aliases map onto the canonical fields", () => {
    const entry = createCacheEntry(
      "<p>y</p>",
      null,
      { revalidate: 10, swr: 50 }
    );
    expect(entry.maxAgeSeconds).toBe(10);
    expect(entry.swrSeconds).toBe(50);
  });

  // ─── 2. Lookup semantics ───────────────────────────────────────────────

  it("lookupCache returns MISS for unknown key", () => {
    const store = new MemoryCacheStore();
    const result = lookupCache(store, "nope");
    expect(result.status).toBe("MISS");
    expect(result.entry).toBeNull();
  });

  it("lookupCache returns HIT while fresh", () => {
    const store = new MemoryCacheStore();
    const entry = createCacheEntry("<p>hit</p>", null, { maxAge: 60, tags: [] });
    store.set("k", entry);
    const result = lookupCache(store, "k");
    expect(result.status).toBe("HIT");
    expect(result.entry).toBe(entry);
  });

  it("lookupCache returns STALE inside the SWR window", () => {
    const store = new MemoryCacheStore();
    // Force an entry that is already past maxAge but still inside SWR.
    const entry: CacheEntry = {
      html: "<p>stale</p>",
      loaderData: null,
      status: 200,
      headers: {},
      createdAt: Date.now() - 10_000,
      revalidateAfter: Date.now() - 1_000, // past fresh window
      staleUntil: Date.now() + 60_000,      // but within SWR
      tags: [],
      maxAgeSeconds: 0,
      swrSeconds: 60,
    };
    store.set("k", entry);
    const result = lookupCache(store, "k");
    expect(result.status).toBe("STALE");
    expect(result.entry).toBe(entry);
  });

  it("lookupCache past the SWR window returns MISS + drops the entry", () => {
    const store = new MemoryCacheStore();
    const entry: CacheEntry = {
      html: "<p>dead</p>",
      loaderData: null,
      status: 200,
      headers: {},
      createdAt: Date.now() - 10_000,
      revalidateAfter: Date.now() - 9_000,
      staleUntil: Date.now() - 1_000, // SWR window also elapsed
      tags: ["dead"],
      maxAgeSeconds: 0,
      swrSeconds: 0,
    };
    store.set("k", entry);
    expect(store.size).toBe(1);
    const result = lookupCache(store, "k");
    expect(result.status).toBe("MISS");
    expect(result.entry).toBeNull();
    expect(store.size).toBe(0); // expired entry physically removed
  });

  // ─── 3. LRU bounds ─────────────────────────────────────────────────────

  it("LRU evicts the oldest entry once maxEntries is exceeded", () => {
    const store = new MemoryCacheStore(2);
    store.set("a", createCacheEntry("A", null, { maxAge: 60 }));
    store.set("b", createCacheEntry("B", null, { maxAge: 60 }));
    store.set("c", createCacheEntry("C", null, { maxAge: 60 }));
    expect(store.size).toBe(2);
    expect(store.get("a")).toBeNull(); // evicted
    expect(store.get("b")).not.toBeNull();
    expect(store.get("c")).not.toBeNull();
  });

  it("lookupCache HIT promotes the entry to MRU via touch()", () => {
    const store = new MemoryCacheStore(2);
    store.set("a", createCacheEntry("A", null, { maxAge: 60 }));
    store.set("b", createCacheEntry("B", null, { maxAge: 60 }));
    // Touch "a" via lookup -> a becomes MRU, b becomes LRU
    lookupCache(store, "a");
    store.set("c", createCacheEntry("C", null, { maxAge: 60 }));
    // "b" should be evicted, not "a"
    expect(store.get("a")).not.toBeNull();
    expect(store.get("b")).toBeNull();
    expect(store.get("c")).not.toBeNull();
  });

  // ─── 4. Tag invalidation ───────────────────────────────────────────────

  it("deleteByTag removes every entry carrying that tag", () => {
    const store = new MemoryCacheStore();
    store.set("k1", createCacheEntry("1", null, { maxAge: 60, tags: ["posts"] }));
    store.set("k2", createCacheEntry("2", null, { maxAge: 60, tags: ["posts"] }));
    store.set("k3", createCacheEntry("3", null, { maxAge: 60, tags: ["users"] }));
    store.deleteByTag("posts");
    expect(store.get("k1")).toBeNull();
    expect(store.get("k2")).toBeNull();
    expect(store.get("k3")).not.toBeNull();
  });

  it("multi-tag entry is invalidated by ANY of its tags, and other tag indices stay consistent", () => {
    const store = new MemoryCacheStore();
    store.set("k1", createCacheEntry("1", null, { maxAge: 60, tags: ["posts", "posts:42", "user:1"] }));
    store.set("k2", createCacheEntry("2", null, { maxAge: 60, tags: ["posts"] }));
    // Invalidate via a specific tag on k1 only.
    store.deleteByTag("posts:42");
    expect(store.get("k1")).toBeNull();
    expect(store.get("k2")).not.toBeNull();
    // k2 still reachable via the shared "posts" tag index.
    store.deleteByTag("posts");
    expect(store.get("k2")).toBeNull();
  });

  it("revalidateTag() reaches entries via the global store", () => {
    const store = new MemoryCacheStore();
    setGlobalCache(store);
    store.set("k1", createCacheEntry("1", null, { maxAge: 60, tags: ["x"] }));
    revalidateTag("x");
    expect(store.get("k1")).toBeNull();
  });

  it("revalidate() is an alias for revalidateTag()", () => {
    const store = new MemoryCacheStore();
    setGlobalCache(store);
    store.set("k1", createCacheEntry("1", null, { maxAge: 60, tags: ["alias"] }));
    revalidate("alias");
    expect(store.get("k1")).toBeNull();
  });

  // ─── 5. Path invalidation ──────────────────────────────────────────────

  it("revalidatePath() removes all keys for that pathname, regardless of query", () => {
    const store = new MemoryCacheStore();
    setGlobalCache(store);
    store.set("home:/blog?page=1", createCacheEntry("1", null, { maxAge: 60, tags: [] }));
    store.set("home:/blog?page=2", createCacheEntry("2", null, { maxAge: 60, tags: [] }));
    store.set("home:/about", createCacheEntry("3", null, { maxAge: 60, tags: [] }));
    revalidatePath("/blog");
    expect(store.get("home:/blog?page=1")).toBeNull();
    expect(store.get("home:/blog?page=2")).toBeNull();
    expect(store.get("home:/about")).not.toBeNull();
  });

  // ─── 6. Cache-Control + X-Mandu-Cache headers ──────────────────────────

  it("computeCacheControl emits max-age and stale-while-revalidate", () => {
    const entry = createCacheEntry("x", null, { maxAge: 60, staleWhileRevalidate: 300 });
    const cc = computeCacheControl(entry);
    expect(cc).toMatch(/^public, max-age=\d+, stale-while-revalidate=300$/);
  });

  it("computeCacheControl omits stale-while-revalidate when swr=0", () => {
    const entry = createCacheEntry("x", null, { maxAge: 60 });
    const cc = computeCacheControl(entry);
    expect(cc).toBe("public, max-age=60");
  });

  it("createCachedResponse stamps Cache-Control + X-Mandu-Cache + Age", () => {
    const entry = createCacheEntry("<p>hi</p>", null, { maxAge: 60, staleWhileRevalidate: 120 });
    const res = createCachedResponse(entry, "HIT");
    expect(res.headers.get("X-Mandu-Cache")).toBe("HIT");
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toMatch(/public, max-age=\d+, stale-while-revalidate=120/);
    expect(res.headers.get("Age")).toBeDefined();
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("createCachedResponse uses the supplied cacheStatus label (STALE/MISS)", () => {
    const entry = createCacheEntry("<p>hi</p>", null, { maxAge: 60 });
    expect(createCachedResponse(entry, "STALE").headers.get("X-Mandu-Cache")).toBe("STALE");
    expect(createCachedResponse(entry, "MISS").headers.get("X-Mandu-Cache")).toBe("MISS");
  });

  // ─── 7. Stats ──────────────────────────────────────────────────────────

  it("getCacheStoreStats counts hits, stale-hits, misses", () => {
    const store = new MemoryCacheStore();
    store.set("k1", createCacheEntry("1", null, { maxAge: 60 }));
    lookupCache(store, "k1"); // HIT
    lookupCache(store, "k1"); // HIT
    lookupCache(store, "missing"); // MISS
    const stats = getCacheStoreStats(store);
    expect(stats?.hits).toBe(2);
    expect(stats?.misses).toBe(1);
  });

  // ─── 8. Config-driven factory ──────────────────────────────────────────

  it("createCacheStoreFromConfig(true) produces a MemoryCacheStore", () => {
    const store = createCacheStoreFromConfig(true);
    expect(store).toBeInstanceOf(MemoryCacheStore);
  });

  it("createCacheStoreFromConfig(false) returns null (disabled)", () => {
    expect(createCacheStoreFromConfig(false)).toBeNull();
    expect(createCacheStoreFromConfig(undefined)).toBeNull();
  });

  it("createCacheStoreFromConfig({ maxEntries }) respects the LRU bound", () => {
    const store = createCacheStoreFromConfig({ maxEntries: 2 })!;
    expect(store).toBeInstanceOf(MemoryCacheStore);
    store.set("a", createCacheEntry("A", null, { maxAge: 60 }));
    store.set("b", createCacheEntry("B", null, { maxAge: 60 }));
    store.set("c", createCacheEntry("C", null, { maxAge: 60 }));
    expect(store.size).toBe(2);
  });

  it("createCacheStoreFromConfig passes through a custom CacheStore", () => {
    const custom: CacheStore = new MemoryCacheStore();
    const result = createCacheStoreFromConfig(custom);
    expect(result).toBe(custom);
  });

  it("setGlobalCacheDefaults / getGlobalCacheDefaults round-trip", () => {
    expect(getGlobalCacheDefaults()).toBeNull();
    setGlobalCacheDefaults({ defaultMaxAge: 60, defaultSwr: 300 });
    expect(getGlobalCacheDefaults()).toEqual({ defaultMaxAge: 60, defaultSwr: 300 });
    setGlobalCacheDefaults(null);
    expect(getGlobalCacheDefaults()).toBeNull();
  });
});

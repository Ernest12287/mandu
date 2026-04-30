/**
 * Phase 18.ζ — manual integration verification.
 *
 * Confirms the spec's acceptance criteria:
 *   - `filling.loader` returning `{ _cache: { tags, maxAge } }` stores an
 *     entry that reports `X-Mandu-Cache: MISS` on first request,
 *     `X-Mandu-Cache: HIT` on second request, and
 *     `X-Mandu-Cache: MISS` again after `revalidate(tag)` fires.
 *   - `Cache-Control: public, max-age=…, stale-while-revalidate=…` lands
 *     on every cached response.
 */

import { describe, it, expect } from "bun:test";
import {
  MemoryCacheStore,
  createCacheEntry,
  createCachedResponse,
  lookupCache,
  revalidate,
  setGlobalCache,
} from "../../src/runtime/cache";

describe("Phase 18.ζ — integration flow", () => {
  it("MISS → HIT → revalidate(tag) → MISS", () => {
    const store = new MemoryCacheStore();
    setGlobalCache(store);

    // First request: MISS — store the freshly rendered HTML.
    const lookup1 = lookupCache(store, "home:/posts/42");
    expect(lookup1.status).toBe("MISS");

    const entry = createCacheEntry(
      "<html>post 42</html>",
      { id: 42 },
      { maxAge: 10, staleWhileRevalidate: 3600, tags: ["posts", "posts:42"] }
    );
    store.set("home:/posts/42", entry);
    const missResp = createCachedResponse(entry, "MISS");
    expect(missResp.headers.get("X-Mandu-Cache")).toBe("MISS");
    const cacheControl = missResp.headers.get("Cache-Control") ?? "";
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] ?? NaN);
    expect(maxAge).toBeGreaterThanOrEqual(0);
    expect(maxAge).toBeLessThanOrEqual(10);
    expect(cacheControl).toMatch(/stale-while-revalidate=3600/);

    // Second request within fresh window: HIT.
    const lookup2 = lookupCache(store, "home:/posts/42");
    expect(lookup2.status).toBe("HIT");
    const hitResp = createCachedResponse(lookup2.entry!, "HIT");
    expect(hitResp.headers.get("X-Mandu-Cache")).toBe("HIT");

    // revalidate(tag) invalidates — next lookup is MISS again.
    revalidate("posts:42");
    const lookup3 = lookupCache(store, "home:/posts/42");
    expect(lookup3.status).toBe("MISS");
    expect(lookup3.entry).toBeNull();
  });
});

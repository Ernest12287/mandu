/**
 * Phase 17 — LRUCache behaviour matrix.
 *
 * Covers:
 *   - Default + custom maxSize
 *   - Eviction order (LRU semantics, not FIFO)
 *   - `get` promotes the entry, `has` does not
 *   - `onEvict` fires for LRU pressure / delete / clear
 *   - Backward-compat numeric constructor
 *   - Stats bookkeeping
 */

import { describe, test, expect } from "bun:test";
import { LRUCache } from "../lru-cache";

describe("LRUCache", () => {
  test("default maxSize is 1000 when no options passed", () => {
    const cache = new LRUCache<string, number>();
    // Insert 1000 — all fit. The 1001st evicts the first.
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(1000);
    expect(cache.has("k0")).toBe(true);

    cache.set("k1000", 1000);
    expect(cache.size).toBe(1000);
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("k1000")).toBe(true);
  });

  test("numeric constructor is still supported (backward-compat)", () => {
    const cache = new LRUCache<string, string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4"); // evicts "a"
    expect(cache.has("a")).toBe(false);
    expect(cache.size).toBe(3);
  });

  test("rejects invalid maxSize", () => {
    expect(() => new LRUCache({ maxSize: 0 })).toThrow();
    expect(() => new LRUCache({ maxSize: -1 })).toThrow();
    expect(() => new LRUCache({ maxSize: Number.NaN })).toThrow();
  });

  test("evicts least-recently-used entry, not FIFO", () => {
    const cache = new LRUCache<string, number>({ maxSize: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Touch "a" so it becomes most-recently-used.
    cache.get("a");
    // Now inserting "d" must evict "b" (oldest), not "a".
    cache.set("d", 4);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  test("has() does NOT promote (read-only probe)", () => {
    const cache = new LRUCache<string, number>({ maxSize: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // `has` on "a" must not reorder. Inserting "d" should still evict "a".
    expect(cache.has("a")).toBe(true);
    cache.set("d", 4);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
  });

  test("updating an existing key re-inserts as MRU but does not fire onEvict", () => {
    const evicted: Array<[string, number]> = [];
    const cache = new LRUCache<string, number>({
      maxSize: 3,
      onEvict: (k, v) => evicted.push([k, v]),
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("a", 10); // update, a becomes MRU
    expect(evicted).toHaveLength(0);
    cache.set("d", 4); // should evict "b" (now oldest), not "a"
    expect(evicted).toEqual([["b", 2]]);
    expect(cache.get("a")).toBe(10);
  });

  test("onEvict fires on LRU pressure with (key, value)", () => {
    const evicted: Array<[string, number]> = [];
    const cache = new LRUCache<string, number>({
      maxSize: 2,
      onEvict: (k, v) => evicted.push([k, v]),
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    cache.set("d", 4); // evicts "b"
    expect(evicted).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  test("onEvict fires on delete() for present keys only", () => {
    const evicted: Array<[string, number]> = [];
    const cache = new LRUCache<string, number>({
      maxSize: 5,
      onEvict: (k, v) => evicted.push([k, v]),
    });
    cache.set("x", 1);
    expect(cache.delete("x")).toBe(true);
    expect(cache.delete("x")).toBe(false); // already gone
    expect(cache.delete("missing")).toBe(false);
    expect(evicted).toEqual([["x", 1]]);
  });

  test("onEvict fires for every entry during clear()", () => {
    const evicted: string[] = [];
    const cache = new LRUCache<string, number>({
      maxSize: 10,
      onEvict: (k) => evicted.push(k),
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.clear();
    expect(evicted.sort()).toEqual(["a", "b", "c"]);
    expect(cache.size).toBe(0);
  });

  test("onEvict errors are swallowed (must not corrupt state)", () => {
    const cache = new LRUCache<string, number>({
      maxSize: 2,
      onEvict: () => {
        throw new Error("boom");
      },
    });
    cache.set("a", 1);
    cache.set("b", 2);
    // Would throw during eviction if errors weren't caught.
    expect(() => cache.set("c", 3)).not.toThrow();
    expect(cache.size).toBe(2);
    expect(cache.has("a")).toBe(false);
  });

  test("getWithStats records hits/misses; getStats reports hit rate", () => {
    const cache = new LRUCache<string, number>({ maxSize: 10 });
    cache.set("a", 1);
    cache.getWithStats("a"); // hit
    cache.getWithStats("a"); // hit
    cache.getWithStats("b"); // miss
    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
    expect(stats.size).toBe(1);
    expect(stats.maxSize).toBe(10);
    cache.resetStats();
    expect(cache.getStats().hits).toBe(0);
    expect(cache.getStats().misses).toBe(0);
  });

  test("entries() yields LRU → MRU order", () => {
    const cache = new LRUCache<string, number>({ maxSize: 5 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a"); // a becomes MRU
    const keys = [...cache.entries()].map(([k]) => k);
    expect(keys).toEqual(["b", "c", "a"]);
  });

  test("fill-past-max proof: 1001 writes against a 1000-entry cache evict exactly the oldest", () => {
    const cache = new LRUCache<number, number>({ maxSize: 1000 });
    for (let i = 0; i < 1000; i++) cache.set(i, i);
    expect(cache.size).toBe(1000);
    expect(cache.has(0)).toBe(true);

    cache.set(1000, 1000);
    expect(cache.size).toBe(1000); // still bounded
    expect(cache.has(0)).toBe(false); // oldest gone
    expect(cache.has(1000)).toBe(true); // newest present
    expect(cache.has(500)).toBe(true); // middle survives
  });
});

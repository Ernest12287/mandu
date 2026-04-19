/**
 * 간단한 LRU (Least Recently Used) 캐시 구현.
 *
 * Phase 17 — bounded caches for memory safety. Used by:
 *   - `client/router.ts` patternCache (compiled route regex cache)
 *   - `client/use-fetch.ts` fetchCache (browser data cache)
 *   - `bundler/dev.ts` perFileTimers (debounce map)
 *
 * O(1) get / set on top of `Map` insertion order:
 *   - `get` re-inserts the entry so it becomes the newest
 *   - `set` evicts the first (oldest) key when over `maxSize`
 *
 * Optional `onEvict` callback fires when an entry is dropped through LRU
 * pressure OR explicit `delete`/`clear` — lets callers release resources
 * attached to the value (e.g. `clearTimeout(timer)` for debounce maps).
 */
export interface LRUCacheOptions<K, V> {
  /** Maximum number of entries. Defaults to `1000`. */
  maxSize?: number;
  /**
   * Fired when an entry leaves the cache. Called for LRU eviction,
   * `delete(key)`, and each entry during `clear()`. Errors are swallowed
   * so a bad callback cannot corrupt cache state.
   */
  onEvict?: (key: K, value: V) => void;
}

export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private readonly maxSize: number;
  private readonly onEvict?: (key: K, value: V) => void;
  private _hits = 0;
  private _misses = 0;

  /**
   * Dual constructor signature for backward compatibility with the
   * original `new LRUCache(200)` call sites:
   *
   *   - `new LRUCache(maxSize)` — legacy numeric form
   *   - `new LRUCache({ maxSize, onEvict })` — options form
   */
  constructor(options?: number | LRUCacheOptions<K, V>) {
    this.cache = new Map();
    if (typeof options === "number") {
      this.maxSize = options;
    } else {
      this.maxSize = options?.maxSize ?? 1000;
      this.onEvict = options?.onEvict;
    }
    if (!Number.isFinite(this.maxSize) || this.maxSize < 1) {
      throw new Error(`LRUCache: maxSize must be >= 1 (got ${this.maxSize})`);
    }
  }

  /**
   * Retrieve a value AND promote it to the most-recently-used position.
   * Returns `undefined` for misses. `has()` does NOT promote.
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Re-insert to mark as most-recently-used.
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * Same as `get` but also increments hit/miss counters.
   * Use `getStats()` to read the tallies.
   */
  getWithStats(key: K): V | undefined {
    const value = this.get(key);
    if (value !== undefined) {
      this._hits++;
    } else {
      this._misses++;
    }
    return value;
  }

  /**
   * Insert / update an entry. If at capacity, evicts the oldest entry
   * and fires `onEvict` for it.
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Update in place → delete then re-insert so the new value is
      // positioned at the MRU end. No eviction callback here (same key).
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // At capacity → drop the oldest.
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        const oldValue = this.cache.get(firstKey) as V;
        this.cache.delete(firstKey);
        this.fireEvict(firstKey, oldValue);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Explicit removal. Fires `onEvict` for the removed entry. Returns
   * `true` iff the key was present.
   */
  delete(key: K): boolean {
    const value = this.cache.get(key);
    const existed = this.cache.delete(key);
    if (existed) {
      this.fireEvict(key, value as V);
    }
    return existed;
  }

  /**
   * Drop every entry. Fires `onEvict` for each before clearing so
   * callers can bulk-release resources (e.g. clear every timer).
   */
  clear(): void {
    if (this.onEvict) {
      // Iterate BEFORE clearing so the callback sees a valid entry.
      for (const [k, v] of this.cache) {
        this.fireEvict(k, v);
      }
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Read-only iteration for introspection (metrics, debug dumps).
   * Yields entries in LRU → MRU order.
   */
  *entries(): IterableIterator<[K, V]> {
    yield* this.cache.entries();
  }

  getStats(): { hits: number; misses: number; hitRate: number; size: number; maxSize: number } {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
  }

  private fireEvict(key: K, value: V): void {
    if (!this.onEvict) return;
    try {
      this.onEvict(key, value);
    } catch {
      // Swallow — a bad callback must not corrupt cache state. Users
      // who need error visibility can wrap their own callback.
    }
  }
}

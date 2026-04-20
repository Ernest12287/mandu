/**
 * Mandu SSR Cache Layer
 * ISR(Incremental Static Regeneration) + SWR(Stale-While-Revalidate) 지원
 */

// ========== Types ==========

export interface CacheEntry {
  /** 렌더링된 HTML */
  html: string;
  /** 직렬화된 loader 데이터 */
  loaderData: unknown;
  /** 응답 상태 코드 */
  status: number;
  /** 응답 헤더 */
  headers: Record<string, string>;
  /** 생성 시간 (ms) */
  createdAt: number;
  /** stale이 되는 시간 (ms) — createdAt + maxAge * 1000 */
  revalidateAfter: number;
  /**
   * Phase 18.ζ — stale-while-revalidate 창 종료 시점 (ms).
   * `revalidateAfter <= now < staleUntil` 구간이면 STALE 로 서빙하면서
   * 백그라운드 재생성. `now >= staleUntil` 이면 MISS 로 취급하여 동기 재생성.
   * `revalidateAfter` 와 동일한 값이면 SWR 창이 없는 것.
   */
  staleUntil: number;
  /** 무효화 태그 */
  tags: string[];
  /**
   * Phase 18.ζ — maxAge (초). CDN 용 Cache-Control 헤더 계산에 사용.
   */
  maxAgeSeconds: number;
  /**
   * Phase 18.ζ — stale-while-revalidate 창 길이 (초). Cache-Control 헤더의
   * `stale-while-revalidate=` 지시자로 그대로 반영된다. 0 이면 생략.
   */
  swrSeconds: number;
}

export type CacheStatus = "HIT" | "STALE" | "MISS";

export interface CacheLookupResult {
  status: CacheStatus;
  entry: CacheEntry | null;
}

export interface CacheStoreStats {
  entries: number;
  maxEntries?: number;
  staleEntries?: number;
  hits?: number;
  staleHits?: number;
  misses?: number;
  hitRate?: number;
}

export interface CacheStore {
  get(key: string): CacheEntry | null;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  /** pathname 부분 매칭으로 캐시 삭제 (키 형식: "routeId:pathname") */
  deleteByPath(pathname: string): void;
  deleteByTag(tag: string): void;
  clear(): void;
  readonly size: number;
}

// ========== Memory Cache (LRU) ==========

export class MemoryCacheStore implements CacheStore {
  private cache = new Map<string, CacheEntry>();
  private tagIndex = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private hits = 0;
  private staleHits = 0;
  private misses = 0;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.cache.size;
  }

  get(key: string): CacheEntry | null {
    return this.cache.get(key) ?? null;
  }

  /** LRU 접근 — HIT 확인 후에만 호출하여 stale 엔트리가 승격되지 않도록 */
  touch(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
  }

  set(key: string, entry: CacheEntry): void {
    // 기존 엔트리 태그 인덱스 정리
    if (this.cache.has(key)) {
      this.removeFromTagIndex(key);
    }

    // LRU eviction
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.removeFromTagIndex(oldest);
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, entry);

    // 태그 인덱스 업데이트
    for (const tag of entry.tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagIndex.set(tag, keys);
      }
      keys.add(key);
    }
  }

  delete(key: string): void {
    this.removeFromTagIndex(key);
    this.cache.delete(key);
  }

  deleteByPath(pathname: string): void {
    // 캐시 키 형식: "routeId:pathname?query" — pathname 부분이 일치하는 모든 키 삭제
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      const keyPath = getCachePathname(key);
      if (keyPath === pathname) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.delete(key);
    }
  }

  deleteByTag(tag: string): void {
    const keys = this.tagIndex.get(tag);
    if (!keys) return;

    for (const key of keys) {
      this.cache.delete(key);
      // 해당 key가 다른 태그에도 있으면 거기서도 제거
      for (const [otherTag, otherKeys] of this.tagIndex) {
        if (otherTag !== tag) {
          otherKeys.delete(key);
        }
      }
    }
    this.tagIndex.delete(tag);
  }

  clear(): void {
    this.cache.clear();
    this.tagIndex.clear();
  }

  recordHit(): void {
    this.hits += 1;
  }

  recordStale(): void {
    this.staleHits += 1;
  }

  recordMiss(): void {
    this.misses += 1;
  }

  getStats(): CacheStoreStats {
    const now = Date.now();
    const staleEntries = Array.from(this.cache.values()).filter((entry) => entry.revalidateAfter <= now).length;
    const totalLookups = this.hits + this.staleHits + this.misses;

    return {
      entries: this.cache.size,
      maxEntries: this.maxEntries,
      staleEntries,
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      hitRate: totalLookups > 0 ? this.hits / totalLookups : undefined,
    };
  }

  private removeFromTagIndex(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    for (const tag of entry.tags) {
      this.tagIndex.get(tag)?.delete(key);
    }
  }
}

function getCachePathname(key: string): string {
  const colonIdx = key.indexOf(":");
  const rawPath = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
  try {
    return new URL(rawPath, "http://mandu.local").pathname;
  } catch {
    const queryIdx = rawPath.indexOf("?");
    return queryIdx >= 0 ? rawPath.slice(0, queryIdx) : rawPath;
  }
}

// ========== Cache Lookup ==========

/**
 * 캐시 조회 — HIT / STALE / MISS 판정
 *
 * Phase 18.ζ:
 *   - `now < revalidateAfter`           → HIT       (fresh, serve cached)
 *   - `revalidateAfter <= now < staleUntil` → STALE (serve + revalidate bg)
 *   - `now >= staleUntil`               → MISS     (drop entry, regen sync)
 *
 * SWR 창을 벗어난 만료 엔트리는 본 함수 호출 시점에 물리적으로 delete 하여
 * 태그 인덱스 및 LRU 상에서도 제거한다.
 */
export function lookupCache(store: CacheStore, key: string): CacheLookupResult {
  const entry = store.get(key);
  if (!entry) {
    if ("recordMiss" in store && typeof (store as MemoryCacheStore).recordMiss === "function") {
      (store as MemoryCacheStore).recordMiss();
    }
    return { status: "MISS", entry: null };
  }

  const now = Date.now();
  if (now < entry.revalidateAfter) {
    if ("recordHit" in store && typeof (store as MemoryCacheStore).recordHit === "function") {
      (store as MemoryCacheStore).recordHit();
    }
    // HIT: LRU 승격 (MemoryCacheStore만 해당)
    if ("touch" in store && typeof (store as MemoryCacheStore).touch === "function") {
      (store as MemoryCacheStore).touch(key);
    }
    return { status: "HIT", entry };
  }

  if (now < entry.staleUntil) {
    if ("recordStale" in store && typeof (store as MemoryCacheStore).recordStale === "function") {
      (store as MemoryCacheStore).recordStale();
    }
    // STALE: LRU 승격하지 않음 — eviction 대상으로 유지
    return { status: "STALE", entry };
  }

  // SWR 창 밖: 만료된 엔트리는 제거하고 MISS.
  store.delete(key);
  if ("recordMiss" in store && typeof (store as MemoryCacheStore).recordMiss === "function") {
    (store as MemoryCacheStore).recordMiss();
  }
  return { status: "MISS", entry: null };
}

/**
 * Phase 18.ζ — 엔트리 생성에 쓰이는 캐시 메타데이터.
 *
 * - `maxAge`     : fresh 구간 길이 (초). 기존 `revalidate` 와 동의어.
 * - `swr`        : stale-while-revalidate 창 길이 (초). 기본 0.
 * - `tags`       : 태그 무효화용.
 *
 * `revalidate` 는 과거 API 호환용 별칭이며 `maxAge` 가 미지정이면 사용된다.
 */
export interface CacheMetadata {
  maxAge?: number;
  /** deprecated 별칭 — maxAge 로 매핑 */
  revalidate?: number;
  staleWhileRevalidate?: number;
  /** deprecated 별칭 — staleWhileRevalidate 로 매핑 */
  swr?: number;
  tags?: string[];
}

/**
 * 캐시 엔트리 생성.
 *
 * Phase 18.ζ 시그니처는 overload 로 기존 호출부와 호환된다:
 *   - 구: `createCacheEntry(html, data, revalidate, tags?, status?, headers?)`
 *   - 신: `createCacheEntry(html, data, { maxAge, staleWhileRevalidate, tags }, status?, headers?)`
 */
export function createCacheEntry(
  html: string,
  loaderData: unknown,
  meta: number | CacheMetadata,
  tagsOrStatus?: string[] | number,
  statusOrHeaders?: number | Record<string, string>,
  headersMaybe?: Record<string, string>
): CacheEntry {
  let maxAge: number;
  let swr: number;
  let tags: string[];
  let status: number;
  let headers: Record<string, string>;

  if (typeof meta === "number") {
    // legacy positional signature
    maxAge = meta;
    swr = 0;
    tags = Array.isArray(tagsOrStatus) ? tagsOrStatus : [];
    status = typeof statusOrHeaders === "number" ? statusOrHeaders : 200;
    headers = (typeof statusOrHeaders === "object" && statusOrHeaders !== null
      ? statusOrHeaders
      : headersMaybe) ?? {};
  } else {
    maxAge = meta.maxAge ?? meta.revalidate ?? 0;
    swr = meta.staleWhileRevalidate ?? meta.swr ?? 0;
    tags = meta.tags ?? [];
    status = typeof tagsOrStatus === "number" ? tagsOrStatus : 200;
    headers = (typeof statusOrHeaders === "object" && statusOrHeaders !== null
      ? statusOrHeaders
      : {}) as Record<string, string>;
  }

  if (!Number.isFinite(maxAge) || maxAge < 0) maxAge = 0;
  if (!Number.isFinite(swr) || swr < 0) swr = 0;

  const now = Date.now();
  const revalidateAfter = now + maxAge * 1000;
  // SWR 창 종료 시점은 fresh 구간 끝에서 swr 초 추가. swr=0 이면 revalidateAfter 와 동일.
  const staleUntil = revalidateAfter + swr * 1000;

  return {
    html,
    loaderData,
    status,
    headers,
    createdAt: now,
    revalidateAfter,
    staleUntil,
    tags,
    maxAgeSeconds: maxAge,
    swrSeconds: swr,
  };
}

/**
 * Phase 18.ζ — CDN 정렬용 Cache-Control 문자열 계산.
 *
 *   `public, max-age=<fresh-remaining>, stale-while-revalidate=<swr>`
 *
 * `max-age` 는 **현재 시점에서의 남은 fresh 초** 를 반환하여 다운스트림
 * 캐시(CDN, 브라우저)가 엔트리의 실제 TTL 을 정확히 계산하도록 한다.
 * fresh 구간이 이미 지난 STALE 엔트리는 `max-age=0` 으로 계산된다.
 */
export function computeCacheControl(entry: CacheEntry, now: number = Date.now()): string {
  const remainingFreshMs = Math.max(0, entry.revalidateAfter - now);
  const remainingFreshSec = Math.floor(remainingFreshMs / 1000);
  const parts = [`public`, `max-age=${remainingFreshSec}`];
  if (entry.swrSeconds > 0) {
    parts.push(`stale-while-revalidate=${entry.swrSeconds}`);
  }
  return parts.join(", ");
}

/**
 * 캐시된 Response 생성.
 *
 * Phase 18.ζ 추가:
 *   - `Cache-Control: public, max-age=…, stale-while-revalidate=…` 헤더
 *     자동 부착 (기존 entry.headers 에 Cache-Control 이 있으면 override).
 *   - `X-Mandu-Cache` 는 HIT / STALE / MISS / PRERENDERED 로 디버깅용.
 *   - `Age` 는 엔트리 생성 후 경과 초.
 */
export function createCachedResponse(entry: CacheEntry, cacheStatus: CacheStatus): Response {
  const now = Date.now();
  const age = Math.floor((now - entry.createdAt) / 1000);
  const cacheControl = computeCacheControl(entry, now);
  return new Response(entry.html, {
    status: entry.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...entry.headers,
      "Cache-Control": cacheControl,
      "X-Mandu-Cache": cacheStatus,
      "Age": String(age),
    },
  });
}

// ========== Global Cache + Revalidation API ==========

let globalCacheStore: CacheStore | null = null;

export function setGlobalCache(store: CacheStore): void {
  globalCacheStore = store;
}

export function getGlobalCache(): CacheStore | null {
  return globalCacheStore;
}

/**
 * 특정 경로의 캐시 무효화
 */
export function revalidatePath(path: string): void {
  if (!globalCacheStore) return;
  globalCacheStore.deleteByPath(path);
}

/**
 * 특정 태그의 모든 캐시 무효화
 */
export function revalidateTag(tag: string): void {
  if (!globalCacheStore) return;
  globalCacheStore.deleteByTag(tag);
}

export function getCacheStoreStats(store: CacheStore | null): CacheStoreStats | null {
  if (!store) return null;

  if ("getStats" in store && typeof (store as MemoryCacheStore).getStats === "function") {
    return (store as MemoryCacheStore).getStats();
  }

  return {
    entries: store.size,
  };
}

/**
 * Phase 18.ζ — `revalidate()` 단항 헬퍼.
 *
 * `revalidateTag(tag)` 의 별칭. Next.js 의 `revalidateTag` / `revalidate`
 * API 와 혼용 가능하도록 단일 엔트리 포인트를 제공한다.
 */
export function revalidate(tag: string): void {
  revalidateTag(tag);
}

// ========== Config-driven Construction ==========

/**
 * Phase 18.ζ — `ManduConfig.cache` 블록.
 *
 *   - `defaultMaxAge`   : 로더가 `_cache` 를 내지 않았을 때 적용할 기본 fresh TTL (초).
 *                         `undefined` 또는 0 이면 자동 캐싱하지 않음.
 *   - `defaultSwr`      : 로더가 swr 을 생략했을 때 적용할 기본 SWR 창 (초).
 *   - `maxEntries`      : LRU 상한. 기본 1000.
 *   - `store`           : 향후 redis 어댑터 자리. 현재는 `"memory"` 만 지원.
 */
export interface CacheConfig {
  defaultMaxAge?: number;
  defaultSwr?: number;
  maxEntries?: number;
  store?: "memory";
}

/**
 * `ManduConfig.cache` 값을 받아 적절한 `CacheStore` 인스턴스를 만든다.
 *
 *   - `false` / `undefined`             → null (캐시 disabled)
 *   - `true`                            → MemoryCacheStore(1000)
 *   - `CacheConfig` 객체                 → MemoryCacheStore(maxEntries)
 *   - 이미 `CacheStore` 모양 객체        → 그대로 반환 (커스텀 어댑터 주입)
 */
export function createCacheStoreFromConfig(
  value: boolean | CacheConfig | CacheStore | undefined
): CacheStore | null {
  if (!value) return null;
  if (value === true) return new MemoryCacheStore();
  // Duck-type: CacheStore 모양이면 그대로 주입
  if (typeof (value as CacheStore).get === "function" && typeof (value as CacheStore).set === "function") {
    return value as CacheStore;
  }
  const cfg = value as CacheConfig;
  return new MemoryCacheStore(cfg.maxEntries ?? 1000);
}

// ========== Config defaults snapshot ==========

/**
 * Phase 18.ζ — `ManduConfig.cache` 에서 추출한 defaults. 서버가 매 요청의
 * `_cache` 메타데이터를 보완할 때 참조한다. `null` 은 "캐시 disabled" 의미.
 */
let globalCacheDefaults: { defaultMaxAge?: number; defaultSwr?: number } | null = null;

export function setGlobalCacheDefaults(defaults: { defaultMaxAge?: number; defaultSwr?: number } | null): void {
  globalCacheDefaults = defaults;
}

export function getGlobalCacheDefaults(): { defaultMaxAge?: number; defaultSwr?: number } | null {
  return globalCacheDefaults;
}

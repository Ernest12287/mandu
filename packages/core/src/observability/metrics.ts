/**
 * Phase 17 — lightweight in-process metrics + heap snapshot.
 *
 * Two outputs are derived from the same underlying state:
 *
 *   1. JSON snapshot (`/_mandu/heap`) — human-oriented debug dump.
 *   2. Prometheus text exposition (`/_mandu/metrics`) — scraper-friendly.
 *
 * Design rules:
 *   - Hand-rolled. No new runtime deps.
 *   - Zero allocation in the hot path — counters are plain numbers.
 *   - Cache sizes are provided through a registry so each cache lives
 *     in its own module (no circular imports). Call
 *     `registerCacheSize("patternCache", () => cache.size)` at module
 *     init; the metrics collector calls each reporter lazily on scrape.
 *   - Label cardinality is strictly bounded — HTTP request counts are
 *     keyed by `{method, statusClass}` where statusClass is `2xx`/`3xx`/
 *     `4xx`/`5xx`/`other`, not the raw status. Prevents runaway series.
 */

export type CacheName = "patternCache" | "fetchCache" | "perFileTimers" | string;

/**
 * Registry of cache-size reporters. Each reporter is called at scrape
 * time and must return the current cache entry count. Reporters that
 * throw or return a non-finite number are treated as `0` (defence
 * against a half-torn-down subsystem).
 */
const cacheSizeReporters = new Map<CacheName, () => number>();

/**
 * Register (or replace) a cache-size reporter. Callers typically wire
 * this at module init:
 *
 *   const cache = new LRUCache<string, Compiled>({ maxSize: 200 });
 *   registerCacheSize("patternCache", () => cache.size);
 */
export function registerCacheSize(name: CacheName, reporter: () => number): void {
  cacheSizeReporters.set(name, reporter);
}

/**
 * Unregister a reporter. Used by hot-reload paths that rebuild their
 * cache under a fresh reference.
 */
export function unregisterCacheSize(name: CacheName): boolean {
  return cacheSizeReporters.delete(name);
}

/**
 * For tests — drop every reporter. Production code should never need this.
 */
export function clearCacheSizeReporters(): void {
  cacheSizeReporters.clear();
}

/**
 * Collect current sizes. Missing reporters simply don't appear. A
 * thrown / non-finite reporter contributes `0` and is silently logged
 * on the event bus (best-effort — we never propagate).
 */
export function collectCacheSizes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, reporter] of cacheSizeReporters) {
    let size = 0;
    try {
      const v = reporter();
      size = typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    } catch {
      size = 0;
    }
    out[name] = size;
  }
  return out;
}

// --------------------------------------------------------------------
// HTTP request counter
// --------------------------------------------------------------------

/**
 * `Map` keyed by `"METHOD statusClass"` for bounded cardinality.
 * E.g. `"GET 2xx"` → 41.
 */
const httpRequestCounter = new Map<string, number>();

const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "other"] as const;
type StatusClass = (typeof STATUS_CLASSES)[number];

function classifyStatus(status: number): StatusClass {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function normalizeMethod(method: string | undefined): string {
  if (!method) return "UNKNOWN";
  const upper = method.toUpperCase();
  // Whitelist standard methods so a rogue "evil\n" header can't break
  // the Prometheus line format. Anything unknown bucket under OTHER.
  const allowed = new Set([
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "OPTIONS",
    "TRACE",
    "CONNECT",
  ]);
  return allowed.has(upper) ? upper : "OTHER";
}

/**
 * Bump the request counter. Safe to call on every request path — O(1).
 * The method/status pair is normalised to a bounded cardinality set.
 */
export function recordHttpRequest(method: string | undefined, status: number): void {
  const m = normalizeMethod(method);
  const cls = classifyStatus(status);
  const key = `${m} ${cls}`;
  httpRequestCounter.set(key, (httpRequestCounter.get(key) ?? 0) + 1);
}

/** Reset counters. Used by tests; prod rarely needs this. */
export function resetHttpRequestCounter(): void {
  httpRequestCounter.clear();
}

/** Snapshot current counts for programmatic inspection. */
export function getHttpRequestCounts(): Array<{ method: string; statusClass: StatusClass; value: number }> {
  const out: Array<{ method: string; statusClass: StatusClass; value: number }> = [];
  for (const [key, value] of httpRequestCounter) {
    const [method, statusClass] = key.split(" ");
    out.push({ method: method!, statusClass: statusClass as StatusClass, value });
  }
  // Stable order → deterministic Prometheus output (aids scraping + tests).
  out.sort((a, b) => {
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return a.statusClass < b.statusClass ? -1 : 1;
  });
  return out;
}

// --------------------------------------------------------------------
// Heap snapshot
// --------------------------------------------------------------------

export interface HeapSnapshot {
  /** Unix epoch millis when snapshot was captured. */
  timestamp: number;
  /** Process uptime in seconds. */
  uptime: number;
  /** `process.memoryUsage()` — always available. */
  process: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  /** `Bun.memoryUsage()` if running on Bun and the API is available. */
  bun?: Record<string, number>;
  /** Current cache entry counts, keyed by reporter name. */
  caches: Record<string, number>;
}

/**
 * Assemble a heap snapshot. This is the single source of truth for
 * both the JSON endpoint and the Prometheus exporter.
 */
export function collectHeapSnapshot(): HeapSnapshot {
  const mem = process.memoryUsage();
  const snapshot: HeapSnapshot = {
    timestamp: Date.now(),
    uptime: process.uptime(),
    process: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers ?? 0,
    },
    caches: collectCacheSizes(),
  };

  // Bun.memoryUsage() is currently a non-standard helper; we feature-
  // detect to stay forward-compatible with other runtimes (Node tests,
  // edge workers) where the global is absent.
  const bunGlobal = (globalThis as { Bun?: { memoryUsage?: () => Record<string, number> } }).Bun;
  if (bunGlobal?.memoryUsage) {
    try {
      const bunMem = bunGlobal.memoryUsage();
      if (bunMem && typeof bunMem === "object") {
        snapshot.bun = bunMem;
      }
    } catch {
      // Swallow — not every Bun version ships this.
    }
  }

  return snapshot;
}

// --------------------------------------------------------------------
// Prometheus text exposition
// --------------------------------------------------------------------

/**
 * Escape a label value per Prometheus text format §
 *
 *   - backslash → `\\`
 *   - newline → `\n`
 *   - double-quote → `\"`
 *
 * We never inline tab/CR because `normalizeMethod` already clamps
 * methods to uppercase ASCII and statusClass is a fixed enum.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/**
 * Render the current metric state in Prometheus text format. Each
 * metric starts with `# HELP` + `# TYPE` headers per the spec.
 *
 * The output is deterministic (sorted labels, stable order) so tests
 * can snapshot against it and scrapers get a consistent diff.
 */
export function renderPrometheus(snapshot?: HeapSnapshot): string {
  const snap = snapshot ?? collectHeapSnapshot();
  const lines: string[] = [];

  // Node/Bun heap gauges.
  lines.push(
    "# HELP nodejs_heap_used_bytes Process heap used in bytes (process.memoryUsage().heapUsed).",
    "# TYPE nodejs_heap_used_bytes gauge",
    `nodejs_heap_used_bytes ${snap.process.heapUsed}`,
    "# HELP nodejs_heap_total_bytes Process heap total in bytes (process.memoryUsage().heapTotal).",
    "# TYPE nodejs_heap_total_bytes gauge",
    `nodejs_heap_total_bytes ${snap.process.heapTotal}`,
    "# HELP nodejs_external_bytes Process external memory in bytes (process.memoryUsage().external).",
    "# TYPE nodejs_external_bytes gauge",
    `nodejs_external_bytes ${snap.process.external}`,
    "# HELP nodejs_rss_bytes Process resident set size in bytes.",
    "# TYPE nodejs_rss_bytes gauge",
    `nodejs_rss_bytes ${snap.process.rss}`,
    "# HELP nodejs_uptime_seconds Process uptime in seconds.",
    "# TYPE nodejs_uptime_seconds gauge",
    `nodejs_uptime_seconds ${snap.uptime.toFixed(3)}`,
  );

  // Cache entry counts — one line per registered reporter. Keys are
  // emitted in sorted order so the output is stable across scrapes.
  lines.push(
    "# HELP mandu_cache_entries Current entry count for Mandu internal caches.",
    "# TYPE mandu_cache_entries gauge",
  );
  const cacheNames = Object.keys(snap.caches).sort();
  if (cacheNames.length === 0) {
    // Prometheus requires at least one sample for the series to be
    // useful; emit a zero-valued placeholder so scrapers don't drop
    // the metric entirely on an empty registry.
    lines.push(`mandu_cache_entries{cache="none"} 0`);
  } else {
    for (const name of cacheNames) {
      lines.push(`mandu_cache_entries{cache="${escapeLabelValue(name)}"} ${snap.caches[name]}`);
    }
  }

  // HTTP request counter.
  lines.push(
    "# HELP mandu_http_requests_total Total HTTP requests served by the Mandu runtime.",
    "# TYPE mandu_http_requests_total counter",
  );
  const counts = getHttpRequestCounts();
  if (counts.length === 0) {
    lines.push(`mandu_http_requests_total{method="GET",status="2xx"} 0`);
  } else {
    for (const { method, statusClass, value } of counts) {
      lines.push(
        `mandu_http_requests_total{method="${escapeLabelValue(method)}",status="${escapeLabelValue(statusClass)}"} ${value}`,
      );
    }
  }

  // Final newline — the Prometheus parser is tolerant but conventional.
  return lines.join("\n") + "\n";
}

// --------------------------------------------------------------------
// HTTP endpoint handlers
// --------------------------------------------------------------------

/** Endpoint paths used by the runtime dispatcher. */
export const HEAP_ENDPOINT = "/_mandu/heap";
export const METRICS_ENDPOINT = "/_mandu/metrics";

/**
 * Gate production access. In dev (`isDev=true`) we always allow.
 * In prod the operator must set `MANDU_DEBUG_HEAP=1` (so scrapers
 * cannot trivially probe) unless an explicit config flag opted in.
 */
export function isObservabilityExposed(isDev: boolean, configFlag: boolean | undefined): boolean {
  if (isDev) return configFlag !== false;
  if (configFlag === true) return true;
  return process.env.MANDU_DEBUG_HEAP === "1";
}

export function buildHeapResponse(): Response {
  const snapshot = collectHeapSnapshot();
  return new Response(JSON.stringify(snapshot, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function buildMetricsResponse(): Response {
  const body = renderPrometheus();
  return new Response(body, {
    status: 200,
    headers: {
      // Prometheus text exposition format spec version 0.0.4.
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

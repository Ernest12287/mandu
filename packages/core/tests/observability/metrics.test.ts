/**
 * Phase 17 — metrics module tests.
 *
 * Exercises:
 *   - Heap snapshot shape
 *   - Cache reporter registration / collection
 *   - HTTP counter bucketing
 *   - Prometheus text format (HELP/TYPE/sample lines)
 *   - Label escaping against malicious method strings
 *   - Production gating (isObservabilityExposed)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerCacheSize,
  clearCacheSizeReporters,
  collectCacheSizes,
  recordHttpRequest,
  resetHttpRequestCounter,
  getHttpRequestCounts,
  collectHeapSnapshot,
  renderPrometheus,
  isObservabilityExposed,
  buildHeapResponse,
  buildMetricsResponse,
  HEAP_ENDPOINT,
  METRICS_ENDPOINT,
} from "../../src/observability/metrics";

describe("metrics / cache registry", () => {
  beforeEach(() => {
    clearCacheSizeReporters();
    resetHttpRequestCounter();
  });

  test("registerCacheSize + collectCacheSizes round-trip", () => {
    let n = 0;
    registerCacheSize("patternCache", () => n);
    n = 42;
    expect(collectCacheSizes()).toEqual({ patternCache: 42 });
    n = 7;
    expect(collectCacheSizes()).toEqual({ patternCache: 7 });
  });

  test("faulty reporters contribute 0 instead of throwing", () => {
    registerCacheSize("good", () => 3);
    registerCacheSize("boom", () => {
      throw new Error("nope");
    });
    registerCacheSize("nan", () => Number.NaN);
    registerCacheSize("neg", () => -5);
    const sizes = collectCacheSizes();
    expect(sizes.good).toBe(3);
    expect(sizes.boom).toBe(0);
    expect(sizes.nan).toBe(0);
    expect(sizes.neg).toBe(0);
  });

  test("replacing a reporter with the same key overrides the previous one", () => {
    registerCacheSize("x", () => 1);
    registerCacheSize("x", () => 2);
    expect(collectCacheSizes()).toEqual({ x: 2 });
  });
});

describe("metrics / HTTP counter", () => {
  beforeEach(() => {
    resetHttpRequestCounter();
  });

  test("buckets status codes into 2xx/3xx/4xx/5xx/other", () => {
    recordHttpRequest("GET", 200);
    recordHttpRequest("GET", 204);
    recordHttpRequest("GET", 304);
    recordHttpRequest("POST", 404);
    recordHttpRequest("POST", 500);
    recordHttpRequest("PUT", 999); // other

    const counts = getHttpRequestCounts();
    const find = (m: string, c: string) =>
      counts.find((r) => r.method === m && r.statusClass === c)?.value ?? 0;

    expect(find("GET", "2xx")).toBe(2);
    expect(find("GET", "3xx")).toBe(1);
    expect(find("POST", "4xx")).toBe(1);
    expect(find("POST", "5xx")).toBe(1);
    expect(find("PUT", "other")).toBe(1);
  });

  test("unknown methods are bucketed as OTHER (prevents cardinality blow-up)", () => {
    recordHttpRequest("PROPFIND", 200);
    recordHttpRequest("evil\nhack", 500);
    const counts = getHttpRequestCounts();
    const other = counts.filter((r) => r.method === "OTHER");
    expect(other.length).toBeGreaterThan(0);
  });

  test("sorts output deterministically by method then status class", () => {
    recordHttpRequest("POST", 500);
    recordHttpRequest("GET", 200);
    recordHttpRequest("GET", 404);
    const counts = getHttpRequestCounts();
    expect(counts.map((c) => `${c.method}/${c.statusClass}`)).toEqual([
      "GET/2xx",
      "GET/4xx",
      "POST/5xx",
    ]);
  });
});

describe("metrics / heap snapshot", () => {
  beforeEach(() => {
    clearCacheSizeReporters();
    resetHttpRequestCounter();
  });

  test("collectHeapSnapshot returns a well-shaped payload", () => {
    registerCacheSize("demo", () => 11);
    const snap = collectHeapSnapshot();

    expect(typeof snap.timestamp).toBe("number");
    expect(snap.timestamp).toBeGreaterThan(0);
    expect(typeof snap.uptime).toBe("number");
    expect(snap.uptime).toBeGreaterThanOrEqual(0);

    expect(typeof snap.process.heapUsed).toBe("number");
    expect(snap.process.heapUsed).toBeGreaterThan(0);
    expect(typeof snap.process.heapTotal).toBe("number");
    expect(snap.process.heapTotal).toBeGreaterThan(0);
    expect(typeof snap.process.rss).toBe("number");
    expect(snap.process.rss).toBeGreaterThan(0);
    expect(typeof snap.process.external).toBe("number");

    expect(snap.caches).toEqual({ demo: 11 });
  });

  test("buildHeapResponse returns application/json with the snapshot", async () => {
    registerCacheSize("counter", () => 5);
    const res = buildHeapResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.caches).toEqual({ counter: 5 });
    expect(typeof body.process.heapUsed).toBe("number");
  });
});

describe("metrics / Prometheus text exposition", () => {
  beforeEach(() => {
    clearCacheSizeReporters();
    resetHttpRequestCounter();
  });

  test("emits HELP + TYPE headers for each metric", () => {
    const text = renderPrometheus();
    expect(text).toMatch(/^# HELP nodejs_heap_used_bytes /m);
    expect(text).toMatch(/^# TYPE nodejs_heap_used_bytes gauge$/m);
    expect(text).toMatch(/^# HELP nodejs_heap_total_bytes /m);
    expect(text).toMatch(/^# HELP mandu_cache_entries /m);
    expect(text).toMatch(/^# TYPE mandu_cache_entries gauge$/m);
    expect(text).toMatch(/^# HELP mandu_http_requests_total /m);
    expect(text).toMatch(/^# TYPE mandu_http_requests_total counter$/m);
  });

  test("renders one sample per registered cache", () => {
    registerCacheSize("patternCache", () => 12);
    registerCacheSize("fetchCache", () => 0);
    const text = renderPrometheus();
    expect(text).toContain('mandu_cache_entries{cache="patternCache"} 12');
    expect(text).toContain('mandu_cache_entries{cache="fetchCache"} 0');
  });

  test("renders one sample per (method, statusClass) pair", () => {
    recordHttpRequest("GET", 200);
    recordHttpRequest("GET", 200);
    recordHttpRequest("POST", 500);
    const text = renderPrometheus();
    expect(text).toContain('mandu_http_requests_total{method="GET",status="2xx"} 2');
    expect(text).toContain('mandu_http_requests_total{method="POST",status="5xx"} 1');
  });

  test("starts with '# HELP' (smoke test for scraper compatibility)", () => {
    const text = renderPrometheus();
    expect(text.startsWith("# HELP")).toBe(true);
  });

  test("escapes label values — cannot inject a raw newline", () => {
    // `recordHttpRequest` maps unknown methods to OTHER so we can't
    // directly smuggle bad input through the public API. Exercise the
    // escape path via a reporter with a nasty cache name.
    registerCacheSize('bad"name\nwith\\stuff', () => 3);
    const text = renderPrometheus();
    // Every label value must be on a single line — count that the
    // first newline inside the sample is AFTER the full sample.
    const line = text.split("\n").find((l) => l.startsWith("mandu_cache_entries"));
    expect(line).toBeDefined();
    expect(line).toContain('cache="bad\\"name\\nwith\\\\stuff"');
  });

  test("buildMetricsResponse serves Prometheus content type", async () => {
    const res = buildMetricsResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Type")).toContain("version=0.0.4");
    const body = await res.text();
    expect(body.startsWith("# HELP")).toBe(true);
  });
});

describe("metrics / production gating", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.MANDU_DEBUG_HEAP;
    delete process.env.MANDU_DEBUG_HEAP;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MANDU_DEBUG_HEAP;
    } else {
      process.env.MANDU_DEBUG_HEAP = original;
    }
  });

  test("dev mode exposes endpoints by default", () => {
    expect(isObservabilityExposed(true, undefined)).toBe(true);
  });

  test("dev mode respects explicit opt-out (configFlag=false)", () => {
    expect(isObservabilityExposed(true, false)).toBe(false);
  });

  test("prod mode defaults to hidden", () => {
    expect(isObservabilityExposed(false, undefined)).toBe(false);
  });

  test("prod mode exposes when MANDU_DEBUG_HEAP=1", () => {
    process.env.MANDU_DEBUG_HEAP = "1";
    expect(isObservabilityExposed(false, undefined)).toBe(true);
  });

  test("prod mode respects explicit opt-in via configFlag=true", () => {
    expect(isObservabilityExposed(false, true)).toBe(true);
  });
});

describe("metrics / endpoint paths", () => {
  test("exposed paths match the spec", () => {
    expect(HEAP_ENDPOINT).toBe("/_mandu/heap");
    expect(METRICS_ENDPOINT).toBe("/_mandu/metrics");
  });
});

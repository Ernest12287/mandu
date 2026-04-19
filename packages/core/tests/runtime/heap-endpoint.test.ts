/**
 * Phase 17 — `/_mandu/heap` and `/_mandu/metrics` endpoint tests.
 *
 * Covers:
 *   - Dev mode exposes both endpoints by default
 *   - Production hides them unless MANDU_DEBUG_HEAP=1 OR config opt-in
 *   - JSON shape: heapUsed is a positive integer, cache counts appear
 *   - Prometheus text starts with `# HELP` and contains mandu series
 *   - HTTP request counter bumps across successive requests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startServer,
  createServerRegistry,
  type ManduServer,
  type ServerRegistry,
} from "../../src/runtime/server";
import type { RoutesManifest } from "../../src/spec/schema";
import {
  clearCacheSizeReporters,
  registerCacheSize,
  resetHttpRequestCounter,
} from "../../src/observability/metrics";

const manifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "api/ping",
      pattern: "/api/ping",
      kind: "api",
      module: ".mandu/generated/server/api-ping.ts",
      methods: ["GET"],
    },
  ],
};

describe("heap + metrics endpoints (dev mode)", () => {
  let server: ManduServer | null = null;
  let registry: ServerRegistry;

  beforeEach(() => {
    clearCacheSizeReporters();
    resetHttpRequestCounter();
    registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ pong: true }));
    registerCacheSize("testCache", () => 3);
  });

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    clearCacheSizeReporters();
  });

  it("GET /_mandu/heap returns JSON with a positive heapUsed", async () => {
    server = startServer(manifest, { port: 0, registry, isDev: true });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/_mandu/heap`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await res.json() as {
      process: { heapUsed: number; heapTotal: number; rss: number };
      caches: Record<string, number>;
      uptime: number;
      timestamp: number;
    };
    expect(typeof body.process.heapUsed).toBe("number");
    expect(body.process.heapUsed).toBeGreaterThan(0);
    expect(Number.isInteger(body.process.heapUsed)).toBe(true);
    expect(body.caches.testCache).toBe(3);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("GET /_mandu/metrics returns Prometheus text starting with '# HELP'", async () => {
    server = startServer(manifest, { port: 0, registry, isDev: true });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/_mandu/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");

    const body = await res.text();
    expect(body.startsWith("# HELP")).toBe(true);
    expect(body).toContain("nodejs_heap_used_bytes");
    expect(body).toContain("mandu_cache_entries");
    expect(body).toContain('mandu_cache_entries{cache="testCache"} 3');
    expect(body).toContain("mandu_http_requests_total");
  });

  it("counter bumps across API requests", async () => {
    server = startServer(manifest, { port: 0, registry, isDev: true });
    const port = server.server.port;

    for (let i = 0; i < 3; i++) {
      const r = await fetch(`http://localhost:${port}/api/ping`);
      expect(r.status).toBe(200);
    }

    const body = await (await fetch(`http://localhost:${port}/_mandu/metrics`)).text();
    // The test framework's GET /_mandu/metrics also bumps the counter,
    // so `GET 2xx` should be at least 3 (ping) + 1 (this fetch). Use ≥
    // so concurrent test harnesses don't flake.
    const match = body.match(/mandu_http_requests_total\{method="GET",status="2xx"\} (\d+)/);
    expect(match).not.toBeNull();
    const count = Number(match![1]);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("config opt-out via observability.heapEndpoint=false hides the endpoint in dev", async () => {
    server = startServer(manifest, {
      port: 0,
      registry,
      isDev: true,
      observability: { heapEndpoint: false },
    });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/_mandu/heap`);
    // Falls through to route-not-found → 404 (not 200 with JSON)
    expect(res.status).toBe(404);
  });
});

describe("heap + metrics endpoints (production gating)", () => {
  let server: ManduServer | null = null;
  let registry: ServerRegistry;
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.MANDU_DEBUG_HEAP;
    delete process.env.MANDU_DEBUG_HEAP;
    clearCacheSizeReporters();
    resetHttpRequestCounter();
    registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ pong: true }));
  });

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    if (originalFlag === undefined) {
      delete process.env.MANDU_DEBUG_HEAP;
    } else {
      process.env.MANDU_DEBUG_HEAP = originalFlag;
    }
    clearCacheSizeReporters();
  });

  it("hides /_mandu/heap by default in production", async () => {
    server = startServer(manifest, { port: 0, registry, isDev: false });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/_mandu/heap`);
    expect(res.status).toBe(404);
  });

  it("exposes /_mandu/heap when MANDU_DEBUG_HEAP=1", async () => {
    process.env.MANDU_DEBUG_HEAP = "1";
    server = startServer(manifest, { port: 0, registry, isDev: false });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/_mandu/heap`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.process.heapUsed).toBe("number");
  });

  it("exposes /_mandu/metrics when observability.metricsEndpoint=true", async () => {
    server = startServer(manifest, {
      port: 0,
      registry,
      isDev: false,
      observability: { metricsEndpoint: true },
    });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/_mandu/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith("# HELP")).toBe(true);
  });
});

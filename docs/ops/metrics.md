# Observability endpoints

Phase 17 ships two runtime-local endpoints for operators:

| Path               | Format                    | Purpose                                                    |
|--------------------|---------------------------|------------------------------------------------------------|
| `/_mandu/heap`     | JSON                      | Full heap snapshot + registered cache sizes                |
| `/_mandu/metrics`  | Prometheus text v0.0.4    | Counters and gauges consumable by Prometheus / Grafana     |

## When they are exposed

| Mode  | Default           | How to override                                                        |
|-------|-------------------|------------------------------------------------------------------------|
| dev   | Both **exposed**  | `observability.{heapEndpoint,metricsEndpoint}: false` in `mandu.config`|
| prod  | Both **hidden**   | `MANDU_DEBUG_HEAP=1` **or** `observability.*: true` in config          |

Hidden endpoints fall through to the normal route-not-found path and return `404`. There is no distinct "disabled" response — scrapers cannot detect whether an endpoint exists.

## `/_mandu/heap`

Returns a JSON snapshot. Example (truncated):

```json
{
  "timestamp": 1713528725120,
  "uptime": 132.45,
  "process": {
    "rss": 158720000,
    "heapTotal": 82018304,
    "heapUsed": 61314960,
    "external": 1948512,
    "arrayBuffers": 32768
  },
  "bun": { "rss": 158720000, "external": 1948512 },
  "caches": {
    "patternCache": 7,
    "fetchCache": 0,
    "perFileTimers": 2
  }
}
```

- `process.*` is `process.memoryUsage()` verbatim.
- `bun` is populated when running on Bun (best-effort; absent otherwise).
- `caches` is the live size of every cache that registered with `registerCacheSize`. New caches can register at runtime and will appear on subsequent snapshots.

## `/_mandu/metrics`

Prometheus text exposition format. Sample:

```text
# HELP nodejs_heap_used_bytes Process heap used in bytes (process.memoryUsage().heapUsed).
# TYPE nodejs_heap_used_bytes gauge
nodejs_heap_used_bytes 61314960
# HELP nodejs_heap_total_bytes Process heap total in bytes (process.memoryUsage().heapTotal).
# TYPE nodejs_heap_total_bytes gauge
nodejs_heap_total_bytes 82018304
# HELP mandu_cache_entries Current entry count for Mandu internal caches.
# TYPE mandu_cache_entries gauge
mandu_cache_entries{cache="patternCache"} 7
mandu_cache_entries{cache="fetchCache"} 0
mandu_cache_entries{cache="perFileTimers"} 2
# HELP mandu_http_requests_total Total HTTP requests served by the Mandu runtime.
# TYPE mandu_http_requests_total counter
mandu_http_requests_total{method="GET",status="2xx"} 412
mandu_http_requests_total{method="POST",status="4xx"} 3
```

### Cardinality safety

- **`method`** labels are whitelisted (GET/HEAD/POST/PUT/DELETE/PATCH/OPTIONS/TRACE/CONNECT). Anything else buckets under `OTHER`.
- **`status`** labels are class buckets (`2xx`/`3xx`/`4xx`/`5xx`/`other`), never raw codes.

This keeps the series count bounded at `9 methods x 5 classes = 45` maximum, regardless of traffic shape.

### Scrape recommendations

```yaml
scrape_configs:
  - job_name: "mandu"
    scrape_interval: 30s
    metrics_path: /_mandu/metrics
    static_configs:
      - targets: ["mandu-app.internal:3000"]
```

Put the endpoint behind an allowlist (reverse proxy / network policy) before enabling in prod. `MANDU_DEBUG_HEAP=1` is a safety net, not an authentication scheme.

## MCP heartbeat

The MCP server (`@mandujs/mcp`) logs a heap summary to stderr on startup and every 5 minutes afterward. Format:

```
[MCP startup] rss=142MB heapUsed=56MB heapTotal=80MB external=3MB uptime=0s
[MCP heartbeat] rss=158MB heapUsed=61MB heapTotal=82MB external=3MB uptime=301s
```

Disable with `MANDU_MCP_HEAP_INTERVAL_MS=0`; tune with a positive number of ms for stress tests.

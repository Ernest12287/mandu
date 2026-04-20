---
title: Performance marks (user-facing)
phase: 18.ψ
audience: app developers + framework contributors
owner: core/perf
---

# Performance marks

Mandu ships a user-facing performance measurement API that layers on top of
the framework's existing `MANDU_PERF=1` gate. The API is designed for
sprinkling custom timing across application code (database queries, external
HTTP calls, render hooks) **without paying any cost when the gate is off**.

## TL;DR

```ts
import { time, timeAsync, createPerf } from "@mandujs/core/perf";

// Scoped timing — close-over end() pattern.
const end = time("db-query");
const rows = await db.query("SELECT * FROM users WHERE id = $1", [id]);
end();                               // emits measurement + OTel span

// Async scope — auto-closed, rethrows errors with status=error.
const user = await timeAsync("fetch-user", async () => {
  return await fetch(`/api/user/${id}`).then((r) => r.json());
});

// DI-friendly instance for libraries that want to resolve enablement once.
const perf = createPerf({ enabled: process.env.MANDU_PERF === "1" });
perf.time("widget-render")();
```

Run with:

```sh
MANDU_PERF=1 mandu dev
```

Then inspect `GET /_mandu/heap` for the histogram + last-N marks.

## Why a new API

The Phase 0 `mark()` / `measure()` pair records a start timestamp under a
named key and later computes the delta. That shape is excellent for
**framework code**, where open/close often happen in different functions
(e.g., HMR detects a file change in one place and closes the rebuild marker
in another). It is awkward for **application code**, where both ends of a
measurement typically live in the same lexical scope:

```ts
// OK but noisy — forces you to invent unique "db-user-123" names.
mark("db-user-123");
const rows = await db.query("...");
measure("db user query", "db-user-123");

// Ergonomic — start/end flow with control flow.
const end = time("db-query");
const rows = await db.query("...");
end();
```

Both APIs coexist. Framework callers in `bundler/`, `runtime/streaming-ssr`,
and `cli/commands/dev` continue to use `mark()` / `measure()` for `console.log`
output on the HMR cold-start benchmark path. The new `time()` / `timeAsync()`
flow through the same `MANDU_PERF=1` gate and feed the same
`/_mandu/heap` dashboard.

## Zero-overhead gating

When `MANDU_PERF=1` is **not** set:

- `time(name)` returns a **shared, frozen, no-op** `end()` function. No `Map`
  allocation, no span creation, no histogram append, no console output.
- `timeAsync(name, fn)` unwraps to a single branch and a direct `await fn()`.
  The overhead is one boolean check + one await boundary.
- `createPerf({ enabled: false })` returns a no-op instance with the same
  guarantees — useful for library authors who want to wire the feature through
  DI without a global env lookup.

We measured the disabled path at 1000 `time()`/`end()` round-trips in
negligible sub-millisecond total wall time (the function-call overhead
dominates).

## OpenTelemetry integration

When the Phase 18.θ request tracer is active, every user mark **automatically
becomes a child span** under the active request span (looked up via
`AsyncLocalStorage`). The span carries:

| Attribute                  | Value                                               |
|----------------------------|-----------------------------------------------------|
| `mandu.perf.category`      | `"user"` \| `"framework"` \| `"bundler"` \| `"ssr"` |
| `mandu.perf.duration_ms`   | Measured duration as a float                        |
| `<caller-supplied>`        | From `options.attributes`                           |

```ts
const end = time("db-query", {
  category: "user",
  attributes: { "db.system": "postgresql", "db.statement.kind": "select" },
});
// ...
end();
```

### Opting out

For hot loops where the span overhead itself would distort the measurement,
pass `{ trace: false }`:

```ts
const end = time("hot-inner-loop", { trace: false });
// Histogram still records; no span emitted.
end();
```

### Nested spans (`timeAsync`)

`timeAsync()` uses `runWithSpan()` to install its child span as the active
one, so any nested `time()` / `timeAsync()` calls inside `fn` become children
of the outer scope automatically. `time()` does not open an ALS scope
(because its `end()` is called separately), so nested `time()` calls
inherit the request span directly.

## `/_mandu/heap` dashboard

The Phase 17 heap endpoint is extended with a `perf` key:

```jsonc
{
  "timestamp": 1776676240380,
  "uptime": 0.147,
  "process": { "rss": 159424512, "heapUsed": 527844, ... },
  "caches": { ... },
  "perf": {
    "enabled": true,
    "totalCount": 5,
    "bufferedCount": 5,
    "bufferLimit": 1000,
    "histogram": [
      {
        "name": "db-query",
        "count": 3,
        "mean": 22.66,
        "p50": 25.19,
        "p95": 27.83,
        "p99": 27.83,
        "min": 14.95,
        "max": 27.83
      }
    ],
    "recent": [
      { "name": "db-query", "durationMs": 25.19, "category": "user", "timestamp": 1776676240389 },
      { "name": "render-page", "durationMs": 14.67, "category": "user", "timestamp": 1776676240447 }
    ]
  }
}
```

- `totalCount` — closed marks since process start.
- `bufferedCount` — entries currently in the ring buffer.
- `bufferLimit` — constant, `1000`. Older entries evict in FIFO order.
- `histogram` — per-name summary, sorted by descending `count`. Percentiles
  use the nearest-rank method (deterministic, no interpolation) over the
  last 500 observations per name.
- `recent` — up to 50 newest marks in chronological order.

### Gating parity

The same `isObservabilityExposed()` check that guards the Phase 17 heap /
metrics endpoints applies. In dev the endpoint is on by default; in prod it
requires `MANDU_DEBUG_HEAP=1` **or** `observability.heapEndpoint: true` in
`ServerOptions`.

## Comparison with Next.js `performance.mark`

Next.js exposes `performance.mark()` / `performance.measure()` through the
standard Web Performance API. Pros: zero learning curve for developers who
already use browser perf tooling; compatible with `PerformanceObserver`.

Mandu's approach differs in three ways:

1. **Gated by default.** Web Performance API entries accumulate in the
   browser's user-timing buffer regardless of any flag. Mandu requires
   `MANDU_PERF=1` explicitly — so dropping `time()` calls into hot paths
   is safe in production.
2. **OTel-native.** Next.js leaves OTel integration to the application
   (via `OTEL_SDK`). Mandu stitches user marks into the active trace
   automatically, with a documented category attribute.
3. **Built-in histogram.** Next.js emits individual events; aggregation is
   the consumer's problem. Mandu ships percentiles + count + min/max in
   `/_mandu/heap` so developers see a running summary without any
   scraping pipeline.

Developers who prefer the Web API can still use `performance.mark()` and
`performance.measure()` — Mandu does not intercept them. The Mandu API is
additive.

## API reference

### `time(name, options?): () => number`

Open a measurement. Returns an `end()` function. Calling `end()` closes the
mark and returns the measured duration in milliseconds. Second and later
calls to `end()` are no-ops that return `0`.

### `timeAsync(name, fn, options?): Promise<T>`

Measure the wall-clock time of `fn`. Propagates the resolved value; rethrows
errors after recording the mark with `status=error` on the OTel span.

### `createPerf(options?): Perf`

Create a scoped instance. `opts.enabled` overrides the global gate (useful
for DI-style library code).

### Options

| Key          | Type                                          | Default    |
|--------------|-----------------------------------------------|------------|
| `category`   | `"user" \| "framework" \| "bundler" \| "ssr"` | `"user"`   |
| `trace`      | `boolean`                                     | `true`     |
| `attributes` | `Record<string, string \| number \| boolean>` | `{}`       |

### Dashboard types

```ts
interface PerfDashboardSnapshot {
  enabled: boolean;
  totalCount: number;
  bufferedCount: number;
  bufferLimit: number;
  histogram: PerfHistogramEntry[];
  recent: PerfMarkEntry[];
}

interface PerfHistogramEntry {
  name: string;
  count: number;
  mean: number;
  p50: number; p95: number; p99: number;
  min: number; max: number;
}

interface PerfMarkEntry {
  name: string;
  durationMs: number;
  category: PerfCategory;
  timestamp: number;
}
```

## Related

- `docs/architect/request-tracing.md` — OpenTelemetry tracer (Phase 18.θ).
- `packages/core/src/perf/hmr-markers.ts` — framework-internal marker names.
- `packages/core/src/observability/metrics.ts` — Phase 17 heap/metrics.

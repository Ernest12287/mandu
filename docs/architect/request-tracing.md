---
title: Request Tracing
description: OpenTelemetry-compatible request tracing in Mandu — W3C Trace Context, AsyncLocalStorage propagation, and OTLP/HTTP export to Honeycomb, Jaeger, and Grafana Tempo.
phase: "18.θ"
status: shipped
---

# Request Tracing

Mandu ships first-class **request tracing** on top of the W3C Trace
Context spec. Every request gets a root `http.request` span whose
trace-id is propagated through middleware, filling loaders, SSR,
sandbox execution, and outgoing `fetch()` calls — no plugin, no extra
runtime dependency.

The feature is **off by default**. Enable it with a two-line config or
a single env var; disabled tracers allocate nothing on the hot path.

## Quick start

### Console exporter (default — dev ergonomic)

```ts
// mandu.config.ts
export default {
  observability: {
    tracing: { enabled: true },
  },
};
```

Every request prints a tree to stderr:

```
[trace 4bf92f35/26529c0f]     ✓ db.query 4.12ms [db.system="postgres"]
[trace 4bf92f35/85bc4462]   ✓ filling.loader 17.60ms
[trace 4bf92f35/8a7dcc35]   ✓ middleware 32.61ms
[trace 4bf92f35/7836e1b1] ✓ http.request 33.20ms [http.method="GET" http.target="/users/123" http.status_code=200]
```

The first two bytes of `traceId` and `spanId` are echoed in the bracket
so you can grep logs for a single request across the fleet.

### OTLP exporter → Honeycomb

```ts
export default {
  observability: {
    tracing: {
      enabled: true,
      exporter: "otlp",
      endpoint: "https://api.honeycomb.io",
      headers: {
        "x-honeycomb-team": process.env.HONEYCOMB_WRITE_KEY!,
        "x-honeycomb-dataset": "mandu",
      },
      serviceName: "my-app",
    },
  },
};
```

### OTLP exporter → Grafana Tempo / OTel Collector

```ts
export default {
  observability: {
    tracing: {
      enabled: true,
      exporter: "otlp",
      endpoint: "http://otel-collector:4318",
      serviceName: "my-app",
    },
  },
};
```

### Env-var override (no config change)

```bash
MANDU_OTEL_ENDPOINT=https://api.honeycomb.io mandu start
```

Overrides both `enabled` and `exporter` — convenient for CI, staging,
and one-off production inspection.

## W3C Trace Context propagation

Mandu speaks the canonical [W3C Trace Context](https://www.w3.org/TR/trace-context/)
wire format. The root request handler:

1. Reads the incoming `traceparent` header. If it matches
   `00-<32 hex>-<16 hex>-<2 hex>` and neither ID is all-zero, Mandu
   adopts that `traceId` and records the incoming span-id as the
   parent of the new root span.
2. Otherwise a fresh W3C-compliant trace-id is minted via
   `crypto.getRandomValues`.
3. `parentId` + `traceId` are emitted on every child span so tools can
   reconstruct the tree server-side.

Outgoing calls:

```ts
import { injectTraceContext } from "@mandujs/core/observability";

export default Mandu.filling().get(async (ctx) => {
  const headers = new Headers();
  injectTraceContext(headers);                // writes `traceparent`
  const res = await fetch("https://upstream.example.com/api", { headers });
  return ctx.json(await res.json());
});
```

`injectTraceContext()` reads the currently-active span from
`AsyncLocalStorage`; passing a span explicitly is supported for
advanced cases (queue producers, durable workflows).

## Opening child spans

Three equivalent APIs — pick the one that reads best in context.

### `ctx.startSpan()` — inside a filling loader / handler

```ts
export default Mandu.filling().get(async (ctx) => {
  const users = await ctx.startSpan("db.query", async (span) => {
    span.setAttribute("db.system", "postgres");
    span.setAttribute("db.statement", "SELECT * FROM users");
    return await ctx.deps.db!.query("SELECT * FROM users");
  });
  return ctx.ok(users);
});
```

Auto-ends on resolve, auto-errors on throw, zero cost when tracing is
disabled.

### `tracer.span()` — outside a ctx context

```ts
import { getTracer } from "@mandujs/core/observability";

await getTracer().span("cron.nightly", async (span) => {
  span.setAttribute("job.name", "nightly-billing");
  await processBilling();
});
```

### Manual lifecycle — when you need to branch

```ts
const span = getTracer().startSpan("complex.op");
try {
  await step1();
  if (shouldFail) span.setStatus("error", "guard failed");
  else span.setStatus("ok");
} finally {
  span.end();
}
```

## AsyncLocalStorage isolation

The active span is kept in [`AsyncLocalStorage`](https://nodejs.org/api/async_context.html#class-asynclocalstorage)
so it survives `await`, timers, and nested callbacks **without
threading a context parameter through every function**. Parallel
requests share no state — each root span lives on its own async
continuation.

This is the same propagation primitive that powers
`@opentelemetry/api`, so Mandu traces interoperate with hand-authored
OTel instrumentation inside your app (e.g. `@opentelemetry/instrumentation-pg`).

## Data model

Mandu spans are a subset of the OTel span model:

| Field            | Type                                                | Notes                                 |
| ---------------- | --------------------------------------------------- | ------------------------------------- |
| `traceId`        | 32-char hex                                         | W3C-compliant, never all-zero         |
| `spanId`         | 16-char hex                                         | W3C-compliant, never all-zero         |
| `parentSpanId`   | 16-char hex / `undefined`                           | `undefined` on root spans             |
| `name`           | string                                              | `http.request`, `db.query`, …         |
| `kind`           | `"server"` / `"internal"` / `"client"` / …          | OTel span kind                        |
| `startTimeMs`    | number                                              | Epoch ms (high-res via `performance`) |
| `endTimeMs`      | number                                              | `-1` until `end()` fires              |
| `status`         | `"unset"` / `"ok"` / `"error"`                      | OTel status code                      |
| `attributes`     | `Record<string, string \| number \| boolean \| null>` | Scalar-only                          |
| `errorMessage`   | string / `undefined`                                | Present on `status=error`             |

The OTLP exporter serialises to the JSON encoding of the
`ExportTraceServiceRequest` protobuf (OTLP v1). Honeycomb, Grafana
Tempo, AWS X-Ray (via the OTel Collector), and the standalone
OpenTelemetry Collector all accept the body shape Mandu emits:

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [{ "key": "service.name", "value": { "stringValue": "my-app" } }]
      },
      "scopeSpans": [
        {
          "scope": { "name": "@mandujs/core", "version": "1" },
          "spans": [
            {
              "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
              "spanId": "7836e1b11b03d021",
              "parentSpanId": "00f067aa0ba902b7",
              "name": "http.request",
              "kind": 2,
              "startTimeUnixNano": "1761921456789000000",
              "endTimeUnixNano": "1761921456823000000",
              "attributes": [
                { "key": "http.method", "value": { "stringValue": "GET" } },
                { "key": "http.status_code", "value": { "intValue": "200" } }
              ],
              "status": { "code": 1 }
            }
          ]
        }
      ]
    }
  ]
}
```

POSTed to `<endpoint>/v1/traces` with `Content-Type: application/json`.
Errors during export are logged to stderr but never break the request.

## Integration recipes

### Honeycomb

```ts
observability: {
  tracing: {
    enabled: true,
    exporter: "otlp",
    endpoint: "https://api.honeycomb.io",
    headers: { "x-honeycomb-team": process.env.HONEYCOMB_KEY! },
    serviceName: "storefront",
  },
}
```

### Jaeger (via OTel Collector)

Run an OTel Collector with the `otlp` receiver + `jaeger` exporter,
point Mandu at the collector:

```yaml
# otel-collector.yaml
receivers: { otlp: { protocols: { http: { endpoint: 0.0.0.0:4318 } } } }
exporters: { jaeger: { endpoint: jaeger:14250, tls: { insecure: true } } }
service: { pipelines: { traces: { receivers: [otlp], exporters: [jaeger] } } }
```

```ts
observability: {
  tracing: {
    enabled: true,
    exporter: "otlp",
    endpoint: "http://otel-collector:4318",
    serviceName: "storefront",
  },
}
```

### Grafana Tempo

Tempo accepts OTLP/HTTP natively:

```ts
observability: {
  tracing: {
    enabled: true,
    exporter: "otlp",
    endpoint: "https://tempo.grafana.net/tempo",
    headers: {
      authorization: `Basic ${Buffer.from("USER:API_TOKEN").toString("base64")}`,
    },
    serviceName: "storefront",
  },
}
```

## Performance

* **Disabled tracer**: `startSpan()` returns a shared no-op span. Zero
  allocations, zero branches beyond a single `if (tracer && tracer.enabled)`
  at the top of the request handler.
* **Enabled, console exporter**: one `RecordingSpan` allocation per
  span (~8 fields), one formatted line per span written to stderr.
  Benchmarks: adds ≈ 15 μs per request for a 4-span tree on Bun 1.3.
* **Enabled, OTLP exporter**: same per-span allocation + a JSON
  serialisation on `end()`. Exports are fire-and-forget — no backpressure,
  no request blocking.

## Reference

| Symbol                                       | Module                                 | Notes                                           |
| -------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| `Tracer`                                     | `@mandujs/core/observability`          | Construct manually or via `createTracerFromConfig` |
| `getTracer()` / `setTracer()`                | `@mandujs/core/observability`          | Process-global accessor                         |
| `Span`                                       | `@mandujs/core/observability`          | Lifecycle: `setAttribute` / `setStatus` / `end` |
| `ctx.span`                                   | `@mandujs/core/filling`                | Active span accessor in fillings                |
| `ctx.startSpan(name, fn, opts?)`             | `@mandujs/core/filling`                | Auto-lifecycle child span                       |
| `parseTraceparent()` / `formatTraceparent()` | `@mandujs/core/observability`          | W3C wire format                                 |
| `getActiveSpan()` / `runWithSpan()`          | `@mandujs/core/observability`          | AsyncLocalStorage bridge                        |
| `injectTraceContext(headers, span?)`         | `@mandujs/core/observability`          | Stamps `traceparent` on outgoing fetches        |
| `encodeOtlpJson(spans, serviceName)`         | `@mandujs/core/observability`          | OTLP body for custom transports                 |

See `packages/core/tests/observability/tracing.test.ts` for exhaustive
examples of every public API.

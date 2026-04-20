/**
 * Phase 18.θ — OpenTelemetry-compatible request tracing tests.
 *
 * Coverage matrix (14 cases):
 *   1. Span lifecycle — start → end, endTimeMs > startTimeMs
 *   2. Span attributes — setAttribute / setAttributes
 *   3. Span status — ok / error transitions
 *   4. Nested spans — parent/child relationships + shared traceId
 *   5. AsyncLocalStorage isolation — parallel requests don't cross-contaminate
 *   6. traceparent parse — happy path + malformed + all-zero rejection
 *   7. traceparent format — roundtrip invariants
 *   8. startSpanFromRequest — inherits incoming traceId, mints new span-id
 *   9. startSpanFromRequest with no header — mints root trace-id
 *  10. injectTraceContext — outgoing header stamped from active span
 *  11. Console exporter — indented output to a capturing stream
 *  12. OTLP JSON encoding — resourceSpans/scopeSpans shape + time units
 *  13. Tracer disabled — startSpan returns no-op, hot path zero-cost
 *  14. runWithSpan — inherits span across awaits + nested runs
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  Tracer,
  ConsoleSpanExporter,
  encodeOtlpJson,
  parseTraceparent,
  formatTraceparent,
  newTraceId,
  newSpanId,
  getActiveSpan,
  runWithSpan,
  injectTraceContext,
  getTracer,
  setTracer,
  resetTracer,
  createTracerFromConfig,
  type Span,
  type SpanExporter,
} from "../../src/observability/tracing";

// ─── Capturing exporter helper ──────────────────────────────────────────

class CaptureExporter implements SpanExporter {
  readonly spans: Span[] = [];
  export(spans: Span[]): void {
    this.spans.push(...spans);
  }
}

// ─── ID / traceparent unit tests ────────────────────────────────────────

describe("tracing / ids", () => {
  test("newTraceId is 32 hex chars, never all-zero", () => {
    for (let i = 0; i < 50; i++) {
      const id = newTraceId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toMatch(/^0+$/);
    }
  });

  test("newSpanId is 16 hex chars, never all-zero", () => {
    for (let i = 0; i < 50; i++) {
      const id = newSpanId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(id).not.toMatch(/^0+$/);
    }
  });
});

describe("tracing / traceparent", () => {
  test("parseTraceparent accepts a valid v1 header", () => {
    const tp = parseTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    );
    expect(tp).toEqual({
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentId: "00f067aa0ba902b7",
      flags: "01",
    });
  });

  test("parseTraceparent rejects malformed / reserved / all-zero", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent("00-too-short-01")).toBeNull();
    // all-zero trace-id forbidden
    expect(
      parseTraceparent(
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01"
      )
    ).toBeNull();
    // all-zero span-id forbidden
    expect(
      parseTraceparent(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"
      )
    ).toBeNull();
    // reserved version "ff" rejected
    expect(
      parseTraceparent(
        "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
      )
    ).toBeNull();
  });

  test("formatTraceparent roundtrips through parseTraceparent", () => {
    const trace = newTraceId();
    const span = newSpanId();
    const header = formatTraceparent(trace, span);
    const parsed = parseTraceparent(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(trace);
    expect(parsed!.parentId).toBe(span);
    expect(parsed!.flags).toBe("01");
  });
});

// ─── Span lifecycle + attributes ────────────────────────────────────────

describe("tracing / span lifecycle", () => {
  let capture: CaptureExporter;
  let tracer: Tracer;

  beforeEach(() => {
    capture = new CaptureExporter();
    tracer = new Tracer({ enabled: true, customExporter: capture });
  });

  test("start → end exports one span with duration > 0", async () => {
    const span = tracer.startSpan("op");
    // Use a timer to guarantee a measurable delta on low-resolution clocks.
    await new Promise((r) => setTimeout(r, 2));
    span.end();
    expect(capture.spans).toHaveLength(1);
    expect(capture.spans[0].name).toBe("op");
    expect(capture.spans[0].endTimeMs).toBeGreaterThan(
      capture.spans[0].startTimeMs
    );
    expect(capture.spans[0].status).toBe("unset");
  });

  test("setAttribute / setAttributes persist until end()", () => {
    const span = tracer.startSpan("op");
    span.setAttribute("http.method", "GET");
    span.setAttributes({ "http.status_code": 200, sampled: true });
    span.end();
    expect(capture.spans[0].attributes).toMatchObject({
      "http.method": "GET",
      "http.status_code": 200,
      sampled: true,
    });
  });

  test("setStatus('error', msg) carries through the exporter", () => {
    const span = tracer.startSpan("op");
    span.setStatus("error", "boom");
    span.end();
    expect(capture.spans[0].status).toBe("error");
    expect(capture.spans[0].errorMessage).toBe("boom");
  });

  test("tracer.span() auto-ends and auto-errors", async () => {
    await expect(
      tracer.span("op", async () => {
        throw new Error("kaboom");
      })
    ).rejects.toThrow("kaboom");
    expect(capture.spans).toHaveLength(1);
    expect(capture.spans[0].status).toBe("error");
    expect(capture.spans[0].errorMessage).toBe("kaboom");
  });
});

// ─── Parent/child / AsyncLocalStorage ───────────────────────────────────

describe("tracing / nested spans + ALS", () => {
  let capture: CaptureExporter;
  let tracer: Tracer;

  beforeEach(() => {
    capture = new CaptureExporter();
    tracer = new Tracer({ enabled: true, customExporter: capture });
  });

  test("child span inherits traceId + sets parentSpanId", () => {
    const root = tracer.startSpan("root");
    runWithSpan(root, () => {
      const child = tracer.startSpan("child");
      expect(child.traceId).toBe(root.traceId);
      expect(child.parentSpanId).toBe(root.spanId);
      child.end();
    });
    root.end();
  });

  test("AsyncLocalStorage isolates parallel runWithSpan scopes", async () => {
    const a = tracer.startSpan("a");
    const b = tracer.startSpan("b");

    await Promise.all([
      runWithSpan(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        expect(getActiveSpan()?.spanId).toBe(a.spanId);
      }),
      runWithSpan(b, async () => {
        await new Promise((r) => setTimeout(r, 2));
        expect(getActiveSpan()?.spanId).toBe(b.spanId);
      }),
    ]);

    a.end();
    b.end();
    expect(capture.spans).toHaveLength(2);
  });

  test("runWithSpan survives nested awaits", async () => {
    const span = tracer.startSpan("op");
    await runWithSpan(span, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(getActiveSpan()?.spanId).toBe(span.spanId);
    });
    span.end();
  });

  test("startSpan without runWithSpan falls back to explicit parent", () => {
    const root = tracer.startSpan("root");
    // No runWithSpan, but we pass parent explicitly.
    const child = tracer.startSpan("child", { parent: root });
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    child.end();
    root.end();
  });
});

// ─── startSpanFromRequest ───────────────────────────────────────────────

describe("tracing / startSpanFromRequest", () => {
  let capture: CaptureExporter;
  let tracer: Tracer;

  beforeEach(() => {
    capture = new CaptureExporter();
    tracer = new Tracer({ enabled: true, customExporter: capture });
  });

  test("inherits traceId from incoming traceparent, mints new span-id", () => {
    const incomingTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const incomingSpan = "00f067aa0ba902b7";
    const req = new Request("https://example.com/a", {
      headers: { traceparent: `00-${incomingTrace}-${incomingSpan}-01` },
    });
    const root = tracer.startSpanFromRequest("http.request", req);
    expect(root.traceId).toBe(incomingTrace);
    expect(root.parentSpanId).toBe(incomingSpan);
    expect(root.spanId).not.toBe(incomingSpan);
    root.end();
  });

  test("no header → mints fresh root trace-id", () => {
    const req = new Request("https://example.com/a");
    const root = tracer.startSpanFromRequest("http.request", req);
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.parentSpanId).toBeUndefined();
    root.end();
  });
});

// ─── injectTraceContext ─────────────────────────────────────────────────

describe("tracing / injectTraceContext", () => {
  test("writes traceparent from the active span", () => {
    const tracer = new Tracer({ enabled: true, customExporter: new CaptureExporter() });
    const span = tracer.startSpan("op");
    const headers = new Headers();
    runWithSpan(span, () => {
      injectTraceContext(headers);
    });
    const tp = parseTraceparent(headers.get("traceparent"));
    expect(tp).not.toBeNull();
    expect(tp!.traceId).toBe(span.traceId);
    expect(tp!.parentId).toBe(span.spanId);
    span.end();
  });

  test("no-op when no active span", () => {
    const headers = new Headers();
    injectTraceContext(headers);
    expect(headers.get("traceparent")).toBeNull();
  });
});

// ─── Exporters ──────────────────────────────────────────────────────────

describe("tracing / ConsoleSpanExporter", () => {
  test("prints indented nested spans to the capture stream", async () => {
    const chunks: string[] = [];
    const stream = { write: (c: string) => chunks.push(c) };
    const exporter = new ConsoleSpanExporter(stream);
    const tracer = new Tracer({ enabled: true, customExporter: exporter });

    await tracer.span("http.request", async () => {
      await tracer.span("filling.loader", async () => {
        await tracer.span("db.query", async () => {});
      });
    });

    expect(chunks.length).toBe(3);
    // Children print before parents because they `end()` first.
    const full = chunks.join("");
    expect(full).toContain("db.query");
    expect(full).toContain("filling.loader");
    expect(full).toContain("http.request");
    // Nested spans must be indented — nested rows contain '  ' after the
    // status icon column.
    const dbLine = chunks.find((c) => c.includes("db.query"))!;
    const rootLine = chunks.find((c) => c.includes("http.request"))!;
    // db.query has depth 2, root has depth 0 — count leading "  " after
    // the "] " separator.
    const indentOf = (line: string) => {
      const body = line.split("] ").slice(1).join("] ");
      return body.length - body.replace(/^\s+/, "").length;
    };
    expect(indentOf(dbLine)).toBeGreaterThan(indentOf(rootLine));
  });
});

describe("tracing / OTLP JSON encoding", () => {
  test("emits ExportTraceServiceRequest-shaped body", () => {
    const tracer = new Tracer({ enabled: true, customExporter: new CaptureExporter() });
    const root = tracer.startSpan("http.request", {
      kind: "server",
      attributes: {
        "http.method": "GET",
        "http.status_code": 200,
        slow: 0.5,
        admin: true,
      },
    });
    root.end();

    const payload = encodeOtlpJson([root], "test-service") as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
        scopeSpans: Array<{
          scope: { name: string };
          spans: Array<{
            traceId: string;
            spanId: string;
            parentSpanId: string;
            name: string;
            kind: number;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
            status: { code: number };
          }>;
        }>;
      }>;
    };
    expect(payload.resourceSpans).toHaveLength(1);
    const rs = payload.resourceSpans[0];
    expect(rs.resource.attributes[0]).toMatchObject({
      key: "service.name",
      value: { stringValue: "test-service" },
    });
    expect(rs.scopeSpans[0].scope.name).toBe("@mandujs/core");
    const span = rs.scopeSpans[0].spans[0];
    expect(span.traceId).toBe(root.traceId);
    expect(span.spanId).toBe(root.spanId);
    expect(span.parentSpanId).toBe("");
    expect(span.kind).toBe(2); // SERVER
    // Times are decimal-string nanoseconds.
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano).toMatch(/^\d+$/);
    expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(
      BigInt(span.startTimeUnixNano)
    );
    // Attribute AnyValue encoding per type.
    const attrMap = new Map(
      span.attributes.map((a) => [a.key, a.value] as const)
    );
    expect(attrMap.get("http.method")).toEqual({ stringValue: "GET" });
    expect(attrMap.get("http.status_code")).toEqual({ intValue: "200" });
    expect(attrMap.get("slow")).toEqual({ doubleValue: 0.5 });
    expect(attrMap.get("admin")).toEqual({ boolValue: true });
    expect(span.status.code).toBe(0); // UNSET (never set)
  });
});

// ─── Disabled tracer + defaults ─────────────────────────────────────────

describe("tracing / disabled tracer", () => {
  test("startSpan returns no-op when enabled=false", () => {
    const tracer = new Tracer({ enabled: false });
    const span = tracer.startSpan("op");
    expect(span.recording).toBe(false);
    // Mutating a no-op span is safe.
    span.setAttribute("x", 1);
    span.setStatus("error", "ignored");
    span.end();
  });

  test("createTracerFromConfig honours MANDU_OTEL_ENDPOINT env var", () => {
    const prev = process.env.MANDU_OTEL_ENDPOINT;
    process.env.MANDU_OTEL_ENDPOINT = "https://otel.example.com";
    try {
      const tracer = createTracerFromConfig({});
      expect(tracer.enabled).toBe(true);
      expect(tracer.config.exporter).toBe("otlp");
      expect(tracer.config.endpoint).toBe("https://otel.example.com");
    } finally {
      if (prev === undefined) delete process.env.MANDU_OTEL_ENDPOINT;
      else process.env.MANDU_OTEL_ENDPOINT = prev;
    }
  });

  test("getTracer / setTracer / resetTracer round-trip", () => {
    const before = getTracer();
    const custom = new Tracer({ enabled: true, customExporter: new CaptureExporter() });
    setTracer(custom);
    expect(getTracer()).toBe(custom);
    resetTracer();
    expect(getTracer()).not.toBe(custom);
    // `before` was the module-init default; resetTracer mints a fresh one
    // so `getTracer() !== before` is also true — we only assert invariants
    // observable to callers: disabled after reset.
    expect(getTracer().enabled).toBe(false);
  });
});

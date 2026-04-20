/**
 * Phase 18.θ — OpenTelemetry-compatible request tracing.
 *
 * Hand-rolled W3C Trace Context + OTLP/HTTP encoder. Zero runtime
 * dependencies (AsyncLocalStorage comes from `node:async_hooks`, which
 * Bun ships natively).
 *
 * Public API:
 *   - {@link Tracer}          — factory for root + child spans
 *   - {@link Span}            — lifecycle + attribute API (`end`, `setAttribute`, `setStatus`)
 *   - {@link parseTraceparent} / {@link formatTraceparent} — W3C wire format
 *   - {@link getActiveSpan}   — AsyncLocalStorage accessor
 *   - {@link runWithSpan}     — bind a span to the async context of a callback
 *   - {@link injectTraceContext} — stamp `traceparent` on outgoing `Headers`
 *   - {@link ConsoleSpanExporter} / {@link OtlpHttpSpanExporter}
 *
 * Design:
 *
 *   1. Tracing is **off by default**. An explicit
 *      `{ enabled: true }` on the config (or `MANDU_OTEL_ENDPOINT` env)
 *      flips it on; otherwise `startSpan()` returns a no-op span and the
 *      hot path is branch-free.
 *
 *   2. Span ids / trace ids are generated via `crypto.getRandomValues`
 *      per the W3C Trace Context spec — 16 bytes for trace-id (hex 32
 *      chars), 8 bytes for span-id (hex 16 chars). The "all zero" case
 *      forbidden by the spec is retried (probability ≈ 2^-128).
 *
 *   3. Parent context comes from the incoming `traceparent` header.
 *      If missing / malformed, a new root trace-id is minted. On
 *      outgoing fetches, {@link injectTraceContext} re-emits the current
 *      context so downstream services see the same trace-id.
 *
 *   4. AsyncLocalStorage keeps the active span in scope across
 *      `await`s, timers, and nested callbacks — without threading an
 *      explicit `ctx` parameter through every function. Works in Bun
 *      1.1+ and Node ≥ 16.
 *
 *   5. OTLP/HTTP exporter serialises spans to the JSON encoding of the
 *      `ExportTraceServiceRequest` protobuf (OTLP v1). Honeycomb,
 *      Grafana Tempo, and the OTel Collector all accept this over HTTP
 *      with `Content-Type: application/json`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ─── W3C Trace Context ──────────────────────────────────────────────────

/**
 * Parsed W3C `traceparent` header. The spec defines exactly four dash-
 * separated fields; anything else yields `null`.
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */
export interface TraceparentFields {
  /** 2-hex-char version. Always `"00"` for v1. */
  version: string;
  /** 32-hex-char trace-id (128-bit). */
  traceId: string;
  /** 16-hex-char span-id (64-bit) of the *parent* span. */
  parentId: string;
  /** 2-hex-char flags byte. Bit 0 = sampled. */
  flags: string;
}

const TRACEPARENT_REGEX =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parse a `traceparent` header. Returns `null` for any header that does
 * not match the v1 grammar, including the all-zero trace-id / span-id
 * cases forbidden by the spec.
 */
export function parseTraceparent(value: string | null | undefined): TraceparentFields | null {
  if (!value) return null;
  const m = TRACEPARENT_REGEX.exec(value.trim());
  if (!m) return null;
  const [, version, traceId, parentId, flags] = m;
  if (version === "ff") return null; // reserved
  if (/^0+$/.test(traceId)) return null;
  if (/^0+$/.test(parentId)) return null;
  return { version, traceId, parentId, flags };
}

/**
 * Format a `traceparent` header for downstream propagation.
 *
 * `flags` defaults to `"01"` (sampled) so the entire trace survives
 * middle hops. Pass `"00"` to mark the span as un-sampled.
 */
export function formatTraceparent(traceId: string, spanId: string, flags: string = "01"): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

// ─── ID generation ──────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Mint a fresh 128-bit W3C-compliant trace-id. Never all-zero. */
export function newTraceId(): string {
  for (;;) {
    const id = randomHex(16);
    if (!/^0+$/.test(id)) return id;
  }
}

/** Mint a fresh 64-bit W3C-compliant span-id. Never all-zero. */
export function newSpanId(): string {
  for (;;) {
    const id = randomHex(8);
    if (!/^0+$/.test(id)) return id;
  }
}

// ─── Span / Tracer ──────────────────────────────────────────────────────

export type SpanStatus = "unset" | "ok" | "error";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

export interface SpanAttributes {
  [key: string]: string | number | boolean | null | undefined;
}

export interface SpanOptions {
  /** Optional span kind. Default: `"internal"`. Root spans use `"server"`. */
  kind?: SpanKind;
  /** Attributes set at span start. Additional attributes can be set via {@link Span.setAttribute}. */
  attributes?: SpanAttributes;
  /**
   * Override the parent span-id. Default: the currently-active span
   * (from AsyncLocalStorage). Use `null` to force a root span.
   */
  parent?: Span | null;
}

/**
 * A single span in the trace tree. Always lifecycle-matched with
 * exactly one {@link Span.end} call — the Tracer's exporter flushes
 * the span only after `end()` returns.
 */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTimeMs: number;
  readonly attributes: SpanAttributes;
  /** `-1` until {@link end} is called. */
  readonly endTimeMs: number;
  readonly status: SpanStatus;
  readonly errorMessage: string | undefined;
  /** `false` for the no-op tracer (feature disabled). */
  readonly recording: boolean;

  setAttribute(key: string, value: string | number | boolean | null | undefined): void;
  setAttributes(attrs: SpanAttributes): void;
  setStatus(status: "ok" | "error", errorMessage?: string): void;
  end(): void;
}

/** Internal mutable state for a recording span. */
class RecordingSpan implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTimeMs: number;
  readonly attributes: SpanAttributes;
  endTimeMs: number = -1;
  status: SpanStatus = "unset";
  errorMessage: string | undefined;
  readonly recording = true;
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    opts: {
      traceId: string;
      spanId: string;
      parentSpanId: string | undefined;
      name: string;
      kind: SpanKind;
      attributes: SpanAttributes;
    }
  ) {
    this.traceId = opts.traceId;
    this.spanId = opts.spanId;
    this.parentSpanId = opts.parentSpanId;
    this.name = opts.name;
    this.kind = opts.kind;
    this.startTimeMs = nowMs();
    this.attributes = { ...opts.attributes };
  }

  setAttribute(key: string, value: string | number | boolean | null | undefined): void {
    if (this.ended) return;
    this.attributes[key] = value;
  }

  setAttributes(attrs: SpanAttributes): void {
    if (this.ended) return;
    Object.assign(this.attributes, attrs);
  }

  setStatus(status: "ok" | "error", errorMessage?: string): void {
    if (this.ended) return;
    this.status = status;
    if (status === "error" && errorMessage) this.errorMessage = errorMessage;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.endTimeMs = nowMs();
    this.tracer._onSpanEnd(this);
  }
}

/** No-op span when tracing is disabled. Zero allocations on hot path. */
const NOOP_SPAN: Span = Object.freeze({
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  parentSpanId: undefined,
  name: "",
  kind: "internal" as SpanKind,
  startTimeMs: 0,
  attributes: {} as SpanAttributes,
  endTimeMs: 0,
  status: "unset" as SpanStatus,
  errorMessage: undefined,
  recording: false,
  setAttribute: () => {},
  setAttributes: () => {},
  setStatus: () => {},
  end: () => {},
});

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    // performance.timeOrigin anchors the high-resolution clock to epoch ms,
    // so exporters emit wall-clock timestamps rather than process-relative ones.
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

// ─── Exporters ──────────────────────────────────────────────────────────

export interface SpanExporter {
  export(spans: Span[]): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

/**
 * Console exporter — pretty-prints each span to stderr on `end()`.
 * Indentation reflects depth (via parent-span lookup in a short-lived
 * Map). Used as the default in dev mode when no OTLP endpoint is set.
 */
export class ConsoleSpanExporter implements SpanExporter {
  private readonly stream: { write: (chunk: string) => void };
  private readonly depthByParent = new Map<string, number>();
  private readonly depthBySpan = new Map<string, number>();

  constructor(stream?: { write: (chunk: string) => void }) {
    // process.stderr guarantees a `write(string)` signature in Bun + Node.
    // Accepting an override keeps the class testable without capturing
    // real TTY output.
    this.stream =
      stream ??
      (typeof process !== "undefined" && process.stderr
        ? (process.stderr as unknown as { write: (chunk: string) => void })
        : { write: (chunk) => console.error(chunk.trimEnd()) });
  }

  export(spans: Span[]): void {
    for (const span of spans) {
      const depth = this.resolveDepth(span);
      const indent = "  ".repeat(depth);
      const durationMs = Math.max(0, span.endTimeMs - span.startTimeMs).toFixed(2);
      const statusIcon =
        span.status === "error" ? "✗" : span.status === "ok" ? "✓" : "·";
      const idTag = `${span.traceId.slice(0, 8)}/${span.spanId.slice(0, 8)}`;
      const attrSummary = formatAttrsShort(span.attributes);
      const err = span.errorMessage ? ` error=${JSON.stringify(span.errorMessage)}` : "";
      this.stream.write(
        `[trace ${idTag}] ${indent}${statusIcon} ${span.name} ${durationMs}ms${attrSummary}${err}\n`
      );
    }
  }

  /**
   * Compute a nesting depth for the span by walking the parent chain we
   * have already seen. The first span we see for a given trace starts at
   * depth 0; each child adds one level of indent. Entries age out when
   * the root span ends so the map stays bounded.
   */
  private resolveDepth(span: Span): number {
    const parent = span.parentSpanId;
    if (!parent) {
      this.depthBySpan.set(span.spanId, 0);
      return 0;
    }
    const parentDepth = this.depthBySpan.get(parent) ?? 0;
    const depth = parentDepth + 1;
    this.depthBySpan.set(span.spanId, depth);
    // Housekeeping: when a root span (depth 0) ends, evict its subtree.
    if (parentDepth === 0 && this.depthBySpan.size > 512) {
      this.depthBySpan.clear();
      this.depthByParent.clear();
    }
    return depth;
  }
}

function formatAttrsShort(attrs: SpanAttributes): string {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const key of keys) {
    const v = attrs[key];
    if (v === undefined || v === null) continue;
    parts.push(`${key}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

/**
 * OTLP/HTTP JSON exporter. Produces an `ExportTraceServiceRequest`
 * body and POSTs it to `<endpoint>/v1/traces`. Honeycomb, Grafana
 * Tempo, AWS X-Ray (via OTel Collector), and the OpenTelemetry
 * Collector all accept this wire format.
 *
 * Errors during export are logged to stderr but never throw — tracing
 * must never break a request.
 */
export class OtlpHttpSpanExporter implements SpanExporter {
  constructor(
    private readonly endpoint: string,
    private readonly serviceName: string,
    private readonly headers: Record<string, string> = {}
  ) {}

  async export(spans: Span[]): Promise<void> {
    if (spans.length === 0) return;
    const body = encodeOtlpJson(spans, this.serviceName);
    const url = this.endpoint.endsWith("/v1/traces")
      ? this.endpoint
      : `${this.endpoint.replace(/\/$/, "")}/v1/traces`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (typeof process !== "undefined" && process.stderr) {
          process.stderr.write(
            `[mandu/tracing] OTLP export failed: ${res.status} ${res.statusText}\n`
          );
        }
      }
    } catch (err) {
      if (typeof process !== "undefined" && process.stderr) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[mandu/tracing] OTLP export error: ${msg}\n`);
      }
    }
  }
}

/**
 * Encode an array of spans as the JSON shape of OTLP
 * `ExportTraceServiceRequest`. Externally-visible for tests and for
 * adapter authors who want to POST spans through a custom transport.
 */
export function encodeOtlpJson(spans: Span[], serviceName: string): Record<string, unknown> {
  // Times in OTLP are unix-nano unsigned ints encoded as decimal strings.
  const toNano = (ms: number): string => {
    const nanos = BigInt(Math.max(0, Math.floor(ms * 1_000_000)));
    return nanos.toString();
  };

  const statusCodeOtlp = (s: SpanStatus): number => {
    // OTel canonical codes: 0 = UNSET, 1 = OK, 2 = ERROR.
    if (s === "ok") return 1;
    if (s === "error") return 2;
    return 0;
  };

  const spanKindOtlp = (k: SpanKind): number => {
    // OTel canonical kinds: 1 = INTERNAL, 2 = SERVER, 3 = CLIENT, 4 = PRODUCER, 5 = CONSUMER.
    switch (k) {
      case "server":
        return 2;
      case "client":
        return 3;
      case "producer":
        return 4;
      case "consumer":
        return 5;
      default:
        return 1;
    }
  };

  const otlpAttr = (key: string, value: string | number | boolean | null | undefined) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return { key, value: { stringValue: value } };
    if (typeof value === "boolean") return { key, value: { boolValue: value } };
    if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
    return { key, value: { doubleValue: value } };
  };

  const otlpSpans = spans.map((s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId ?? "",
    name: s.name,
    kind: spanKindOtlp(s.kind),
    startTimeUnixNano: toNano(s.startTimeMs),
    endTimeUnixNano: toNano(s.endTimeMs > 0 ? s.endTimeMs : s.startTimeMs),
    attributes: Object.entries(s.attributes)
      .map(([k, v]) => otlpAttr(k, v))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    status: {
      code: statusCodeOtlp(s.status),
      ...(s.errorMessage ? { message: s.errorMessage } : {}),
    },
  }));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "@mandujs/core", version: "1" },
            spans: otlpSpans,
          },
        ],
      },
    ],
  };
}

// ─── AsyncLocalStorage context propagation ──────────────────────────────

const spanStorage = new AsyncLocalStorage<Span>();

/**
 * Return the currently-active span, or `undefined` outside any
 * `runWithSpan()` scope. Works across `await`s, timers, and nested
 * callbacks.
 */
export function getActiveSpan(): Span | undefined {
  return spanStorage.getStore();
}

/**
 * Bind a span to the AsyncLocalStorage context of `fn`. Inside (and
 * downstream of) `fn`, {@link getActiveSpan} returns `span`. The span
 * is NOT auto-ended — callers own lifecycle.
 */
export function runWithSpan<T>(span: Span, fn: () => T): T {
  return spanStorage.run(span, fn);
}

/**
 * Stamp the active span's trace context onto `headers` as a
 * `traceparent` header so downstream services can join the trace.
 * No-op when no active span OR the active span is the no-op span.
 */
export function injectTraceContext(headers: Headers, span: Span | undefined = getActiveSpan()): void {
  if (!span || !span.recording) return;
  headers.set("traceparent", formatTraceparent(span.traceId, span.spanId));
}

// ─── Tracer ─────────────────────────────────────────────────────────────

export interface TracerConfig {
  /** Off → `startSpan` returns no-op. Default: `false`. */
  enabled?: boolean;
  /** `"console"` (default) or `"otlp"`. */
  exporter?: "console" | "otlp";
  /** OTLP collector endpoint (e.g. `https://api.honeycomb.io`). Required for `"otlp"`. */
  endpoint?: string;
  /** OTLP headers (e.g. `{ 'x-honeycomb-team': 'KEY' }`). */
  headers?: Record<string, string>;
  /** `resource.service.name`. Default: `"mandu"`. */
  serviceName?: string;
  /** Inject a custom exporter (overrides `exporter` / `endpoint`). Used in tests. */
  customExporter?: SpanExporter;
}

export class Tracer {
  readonly config: Required<
    Omit<TracerConfig, "customExporter" | "endpoint" | "headers">
  > & {
    endpoint?: string;
    headers: Record<string, string>;
    customExporter?: SpanExporter;
  };
  private readonly exporter: SpanExporter | null;

  constructor(config: TracerConfig = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      exporter: config.exporter ?? "console",
      endpoint: config.endpoint,
      headers: config.headers ?? {},
      serviceName: config.serviceName ?? "mandu",
      customExporter: config.customExporter,
    };
    if (!this.config.enabled) {
      this.exporter = null;
    } else if (config.customExporter) {
      this.exporter = config.customExporter;
    } else if (this.config.exporter === "otlp") {
      if (!this.config.endpoint) {
        // Misconfigured → fall back to console so dev still gets output.
        this.exporter = new ConsoleSpanExporter();
      } else {
        this.exporter = new OtlpHttpSpanExporter(
          this.config.endpoint,
          this.config.serviceName,
          this.config.headers
        );
      }
    } else {
      this.exporter = new ConsoleSpanExporter();
    }
  }

  /** Whether this tracer will record spans. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Start a new span. When tracing is disabled, returns the shared
   * no-op span (zero allocations).
   *
   * Parent resolution order:
   *   1. `opts.parent` if provided (use `null` to force a root span)
   *   2. The active span from AsyncLocalStorage
   *   3. None (root span)
   */
  startSpan(name: string, opts: SpanOptions = {}): Span {
    if (!this.config.enabled) return NOOP_SPAN;
    const parent =
      opts.parent === null
        ? undefined
        : opts.parent ?? getActiveSpan();
    const parentRecording = parent && parent.recording ? parent : undefined;
    const traceId = parentRecording ? parentRecording.traceId : newTraceId();
    return new RecordingSpan(this, {
      traceId,
      spanId: newSpanId(),
      parentSpanId: parentRecording?.spanId,
      name,
      kind: opts.kind ?? (parentRecording ? "internal" : "server"),
      attributes: opts.attributes ?? {},
    });
  }

  /**
   * Start a span from an incoming request's `traceparent` header. If
   * the header is missing / malformed, a new root span is minted.
   */
  startSpanFromRequest(name: string, req: Request, opts: Omit<SpanOptions, "parent"> = {}): Span {
    if (!this.config.enabled) return NOOP_SPAN;
    const tp = parseTraceparent(req.headers.get("traceparent"));
    if (!tp) {
      return this.startSpan(name, { ...opts, parent: null, kind: opts.kind ?? "server" });
    }
    return new RecordingSpan(this, {
      traceId: tp.traceId,
      spanId: newSpanId(),
      parentSpanId: tp.parentId,
      name,
      kind: opts.kind ?? "server",
      attributes: opts.attributes ?? {},
    });
  }

  /**
   * Run `fn` with `span` as the active span. Equivalent to
   * {@link runWithSpan} but colocated with the tracer for DX.
   */
  withSpan<T>(span: Span, fn: () => T): T {
    return runWithSpan(span, fn);
  }

  /**
   * Open a child span, invoke `fn`, and auto-end the span when the
   * returned promise resolves (or rejects, with `status=error`).
   */
  async span<T>(name: string, fn: (span: Span) => Promise<T> | T, opts: SpanOptions = {}): Promise<T> {
    const span = this.startSpan(name, opts);
    try {
      const result = await runWithSpan(span, () => fn(span));
      if (span.status === "unset") span.setStatus("ok");
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      span.setStatus("error", msg);
      throw err;
    } finally {
      span.end();
    }
  }

  /** @internal Called by {@link RecordingSpan.end}. */
  _onSpanEnd(span: Span): void {
    if (!this.exporter) return;
    try {
      void this.exporter.export([span]);
    } catch {
      // Exporter failures must never surface — swallow.
    }
  }

  /** Flush + release the underlying exporter. No-op if disabled. */
  async shutdown(): Promise<void> {
    if (this.exporter && typeof this.exporter.shutdown === "function") {
      await this.exporter.shutdown();
    }
  }
}

// ─── Default tracer ──────────────────────────────────────────────────────

let defaultTracer: Tracer = new Tracer({ enabled: false });

/**
 * Return the process-global tracer. Starts disabled; the runtime
 * installs a configured tracer during `startServer()` when
 * `observability.tracing.enabled` is true.
 */
export function getTracer(): Tracer {
  return defaultTracer;
}

/**
 * Install a tracer as the process-global. Idempotent — a subsequent
 * call replaces the previous tracer (the runtime calls this once at
 * boot; tests use it to swap in a capturing exporter).
 */
export function setTracer(tracer: Tracer): void {
  defaultTracer = tracer;
}

/**
 * Reset the process-global tracer back to the disabled no-op tracer.
 * Intended for tests; production code should not need this.
 */
export function resetTracer(): void {
  defaultTracer = new Tracer({ enabled: false });
}

/**
 * Build a tracer from a {@link TracerConfig}-shaped object, honouring
 * the `MANDU_OTEL_ENDPOINT` env var as an override. Used by the
 * runtime at `startServer()` time.
 */
export function createTracerFromConfig(cfg: TracerConfig | undefined): Tracer {
  const envEndpoint =
    typeof process !== "undefined" ? process.env?.MANDU_OTEL_ENDPOINT : undefined;
  const resolved: TracerConfig = { ...(cfg ?? {}) };
  if (envEndpoint) {
    resolved.enabled = true;
    resolved.exporter = "otlp";
    resolved.endpoint = envEndpoint;
  }
  return new Tracer(resolved);
}

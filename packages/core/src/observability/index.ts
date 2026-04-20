export {
  eventBus,
  type ObservabilityEvent,
  type EventType,
  type ObservabilitySeverity,
  type EventHandler,
} from "./event-bus";
export { connectLoggerToEventBus } from "./logger-adapter";
// Phase 6: SQLite 영구 저장 + 시계열 쿼리
export {
  startSqliteStore,
  stopSqliteStore,
  queryEvents,
  queryStats,
  exportJsonl,
  exportOtlp,
  type QueryOptions,
} from "./sqlite-store";
// Phase 17: heap endpoint + Prometheus metrics
export {
  registerCacheSize,
  unregisterCacheSize,
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
  type HeapSnapshot,
  type CacheName,
} from "./metrics";
// Phase 18.θ: OpenTelemetry-compatible request tracing
export {
  Tracer,
  ConsoleSpanExporter,
  OtlpHttpSpanExporter,
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
  type SpanAttributes,
  type SpanExporter,
  type SpanKind,
  type SpanOptions,
  type SpanStatus,
  type TraceparentFields,
  type TracerConfig,
} from "./tracing";

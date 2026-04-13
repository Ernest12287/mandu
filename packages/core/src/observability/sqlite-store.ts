/**
 * Phase 6-1: SQLite 영구 저장소
 *
 * EventBus 이벤트를 .mandu/observability.db에 저장한다.
 * Bun 내장 bun:sqlite를 사용하여 추가 의존성 없음.
 *
 * - 시계열 쿼리 지원 (Phase 6-2)
 * - JSONL/OTLP 내보내기 지원 (Phase 6-3)
 */

import path from "path";
import fs from "fs";
import type { ObservabilityEvent, EventType, ObservabilitySeverity } from "./event-bus";
import { eventBus } from "./event-bus";

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

let dbInstance: SqliteDatabase | null = null;
let unsubscribe: (() => void) | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  duration_ms INTEGER,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_correlation ON events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_severity ON events(severity);
`;

/**
 * SQLite 저장소 초기화 및 EventBus 구독
 */
export async function startSqliteStore(rootDir: string): Promise<void> {
  if (dbInstance) return; // 이미 시작됨

  const dbDir = path.join(rootDir, ".mandu");
  const dbPath = path.join(dbDir, "observability.db");

  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch { /* exists */ }

  // bun:sqlite 동적 import (Bun 환경에서만 동작)
  let Database: new (path: string) => SqliteDatabase;
  try {
    const mod = await import("bun:sqlite");
    Database = mod.Database as unknown as typeof Database;
  } catch {
    console.warn("[Mandu Observability] bun:sqlite unavailable — SQLite store disabled");
    return;
  }

  const db = new Database(dbPath);
  db.exec(SCHEMA);
  dbInstance = db;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO events (id, correlation_id, type, severity, source, message, data, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  unsubscribe = eventBus.on("*", (event) => {
    try {
      insert.run(
        event.id,
        event.correlationId ?? null,
        event.type,
        event.severity,
        event.source,
        event.message,
        event.data ? JSON.stringify(event.data) : null,
        event.duration ?? null,
        event.timestamp,
      );
    } catch {
      // 저장 실패는 silent — 메모리 EventBus는 계속 동작
    }
  });
}

/**
 * SQLite 저장소 중지
 */
export function stopSqliteStore(): void {
  unsubscribe?.();
  unsubscribe = null;
  dbInstance?.close();
  dbInstance = null;
}

/**
 * Phase 6-2: 시계열 쿼리
 */
export interface QueryOptions {
  type?: EventType;
  severity?: ObservabilitySeverity;
  source?: string;
  correlationId?: string;
  sinceMs?: number;        // 절대 timestamp
  untilMs?: number;
  limit?: number;
}

export function queryEvents(options: QueryOptions = {}): ObservabilityEvent[] {
  if (!dbInstance) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.type) { conditions.push("type = ?"); params.push(options.type); }
  if (options.severity) { conditions.push("severity = ?"); params.push(options.severity); }
  if (options.source) { conditions.push("source = ?"); params.push(options.source); }
  if (options.correlationId) { conditions.push("correlation_id = ?"); params.push(options.correlationId); }
  if (options.sinceMs) { conditions.push("timestamp >= ?"); params.push(options.sinceMs); }
  if (options.untilMs) { conditions.push("timestamp <= ?"); params.push(options.untilMs); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit ?? 100;

  const sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ${limit}`;
  const rows = dbInstance.prepare(sql).all(...params) as Array<{
    id: string;
    correlation_id: string | null;
    type: string;
    severity: string;
    source: string;
    message: string;
    data: string | null;
    duration_ms: number | null;
    timestamp: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    correlationId: r.correlation_id ?? undefined,
    type: r.type as EventType,
    severity: r.severity as ObservabilitySeverity,
    source: r.source,
    message: r.message,
    data: r.data ? JSON.parse(r.data) : undefined,
    duration: r.duration_ms ?? undefined,
    timestamp: r.timestamp,
  }));
}

/**
 * Phase 6-2: 시계열 통계 (시간 window 기반)
 */
export function queryStats(windowMs: number): Record<string, { count: number; errors: number; avgDuration: number }> {
  if (!dbInstance) return {};

  const since = Date.now() - windowMs;
  const sql = `
    SELECT
      type,
      COUNT(*) as count,
      SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END) as errors,
      AVG(duration_ms) as avg_duration
    FROM events
    WHERE timestamp >= ?
    GROUP BY type
  `;
  const rows = dbInstance.prepare(sql).all(since) as Array<{
    type: string;
    count: number;
    errors: number;
    avg_duration: number | null;
  }>;

  const result: Record<string, { count: number; errors: number; avgDuration: number }> = {};
  for (const r of rows) {
    result[r.type] = {
      count: r.count,
      errors: r.errors,
      avgDuration: r.avg_duration ?? 0,
    };
  }
  return result;
}

/**
 * Phase 6-3: JSONL 내보내기
 */
export function exportJsonl(options: QueryOptions = {}): string {
  const events = queryEvents({ ...options, limit: options.limit ?? 10_000 });
  return events.map((e) => JSON.stringify(e)).join("\n");
}

/**
 * Phase 6-3: OpenTelemetry 호환 JSON 내보내기
 * (단순화된 trace 형식)
 */
export function exportOtlp(options: QueryOptions = {}): string {
  const events = queryEvents({ ...options, limit: options.limit ?? 10_000 });

  const spans = events.map((e) => ({
    traceId: e.correlationId ?? e.id,
    spanId: e.id,
    name: e.message,
    kind: "SPAN_KIND_INTERNAL",
    startTimeUnixNano: BigInt(e.timestamp) * 1_000_000n,
    endTimeUnixNano: BigInt(e.timestamp + (e.duration ?? 0)) * 1_000_000n,
    attributes: [
      { key: "type", value: { stringValue: e.type } },
      { key: "severity", value: { stringValue: e.severity } },
      { key: "source", value: { stringValue: e.source } },
      ...(e.data
        ? Object.entries(e.data).map(([k, v]) => ({
            key: k,
            value: { stringValue: typeof v === "string" ? v : JSON.stringify(v) },
          }))
        : []),
    ],
    status: { code: e.severity === "error" ? 2 : 1 },
  }));

  // BigInt → string for JSON serialization
  return JSON.stringify(
    {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "mandu" } }] },
          scopeSpans: [{ scope: { name: "mandu-observability" }, spans }],
        },
      ],
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

/**
 * 데이터베이스 인스턴스 (테스트용)
 */
export function getDb(): SqliteDatabase | null {
  return dbInstance;
}

/**
 * Logger -> EventBus adapter
 * Bridges the existing logger sink pattern into the unified observability bus.
 */

import { eventBus } from "./event-bus";
import type { ObservabilitySeverity } from "./event-bus";
import type { LogEntry, LogLevel } from "../runtime/logger";

const LEVEL_MAP: Record<LogLevel, ObservabilitySeverity> = {
  debug: "info",
  info: "info",
  warn: "warn",
  error: "error",
};

export function connectLoggerToEventBus(loggerInstance: { sink?: (entry: LogEntry) => void } & Record<string, unknown>): void {
  const originalSink = loggerInstance.sink as ((entry: LogEntry) => void) | undefined;
  loggerInstance.sink = (entry: LogEntry) => {
    originalSink?.(entry);
    eventBus.emit({
      type: "http",
      severity: LEVEL_MAP[entry.level] ?? "info",
      source: "logger",
      message: `${entry.method} ${entry.path} ${entry.status ?? ""}`.trim(),
      duration: entry.duration,
      data: {
        requestId: entry.requestId,
        method: entry.method,
        path: entry.path,
        status: entry.status,
        slow: entry.slow,
      },
    });
  };
}

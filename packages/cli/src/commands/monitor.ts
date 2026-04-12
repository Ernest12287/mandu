import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { resolveFromCwd, pathExists } from "../util/fs";
import { resolveOutputFormat } from "../util/output";

type MonitorOutput = "console" | "json";

export type EventType = "http" | "mcp" | "guard" | "build" | "error" | "cache";
export type SeverityLevel = "info" | "warn" | "error";

export interface MonitorOptions {
  follow?: boolean;
  summary?: boolean;
  since?: string;
  file?: string;
  type?: EventType;
  severity?: SeverityLevel;
  stats?: boolean;
}

interface MonitorEvent {
  ts?: string;
  type?: string;
  severity?: "info" | "warn" | "error";
  source?: string;
  message?: string;
  data?: Record<string, unknown>;
  count?: number;
}

function parseDuration(value?: string): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? "m";
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    case "d":
      return amount * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}

const SEVERITY_LEVELS: Record<string, number> = { info: 0, warn: 1, error: 2 };

function shouldShow(event: MonitorEvent, opts: MonitorOptions): boolean {
  if (opts.type && !event.type?.startsWith(opts.type)) return false;
  if (opts.severity) {
    if ((SEVERITY_LEVELS[event.severity ?? "info"] ?? 0) < (SEVERITY_LEVELS[opts.severity] ?? 0)) return false;
  }
  return true;
}

function formatTime(ts?: string): string {
  const date = ts ? new Date(ts) : new Date();
  return date.toLocaleTimeString("en-US", { hour12: false });
}

function formatEventForConsole(event: MonitorEvent): string {
  const time = formatTime(event.ts);
  const countSuffix = event.count && event.count > 1 ? ` x${event.count}` : "";
  const type = event.type ?? "event";

  if (type === "tool.call") {
    const tag = (event.data?.tag as string | undefined) ?? "TOOL";
    const argsSummary = event.data?.argsSummary as string | undefined;
    return `${time} → [${tag}]${argsSummary ?? ""}${countSuffix}`;
  }
  if (type === "tool.error") {
    const tag = (event.data?.tag as string | undefined) ?? "TOOL";
    const argsSummary = event.data?.argsSummary as string | undefined;
    const message = event.message ?? "ERROR";
    return `${time} ✗ [${tag}]${argsSummary ?? ""}${countSuffix}\n       ${message}`;
  }
  if (type === "tool.result") {
    const tag = (event.data?.tag as string | undefined) ?? "TOOL";
    const summary = event.data?.summary as string | undefined;
    return `${time} ✓ [${tag}]${summary ?? ""}${countSuffix}`;
  }
  if (type === "watch.warning") {
    const ruleId = event.data?.ruleId as string | undefined;
    const file = event.data?.file as string | undefined;
    const message = event.message ?? "";
    const icon = event.severity === "info" ? "ℹ" : "⚠";
    return `${time} ${icon} [WATCH:${ruleId ?? "UNKNOWN"}] ${file ?? ""}${countSuffix}\n       ${message}`;
  }
  if (type === "guard.violation") {
    const ruleId = event.data?.ruleId as string | undefined;
    const file = event.data?.file as string | undefined;
    const line = event.data?.line as number | undefined;
    const message = event.message ?? (event.data?.message as string | undefined) ?? "";
    const location = line ? `${file}:${line}` : file ?? "";
    return `${time} 🚨 [GUARD:${ruleId ?? "UNKNOWN"}] ${location}${countSuffix}\n       ${message}`;
  }
  if (type === "guard.summary") {
    const count = event.data?.count as number | undefined;
    const passed = event.data?.passed as boolean | undefined;
    return `${time} 🧱 [GUARD] ${passed ? "PASSED" : "FAILED"} (${count ?? 0} violations)`;
  }
  if (type === "routes.change") {
    const action = event.data?.action as string | undefined;
    const routeId = event.data?.routeId as string | undefined;
    const pattern = event.data?.pattern as string | undefined;
    const kind = event.data?.kind as string | undefined;
    const detail = [routeId, pattern, kind].filter(Boolean).join(" ");
    return `${time} 🛣️  [ROUTES:${action ?? "change"}] ${detail}${countSuffix}`;
  }
  if (type === "monitor.summary") {
    return `${time} · SUMMARY ${event.message ?? ""}`;
  }
  if (type === "system.event") {
    const category = event.data?.category as string | undefined;
    return `${time}   [${category ?? "SYSTEM"}] ${event.message ?? ""}${countSuffix}`;
  }

  return `${time}   [${type}] ${event.message ?? ""}${countSuffix}`;
}

async function resolveLogFile(
  rootDir: string,
  output: MonitorOutput,
  explicit?: string
): Promise<string | null> {
  if (explicit) return explicit;

  const manduDir = path.join(rootDir, ".mandu");
  const jsonPath = path.join(manduDir, "activity.jsonl");
  const logPath = path.join(manduDir, "activity.log");

  const hasJson = await pathExists(jsonPath);
  const hasLog = await pathExists(logPath);

  if (output === "json") {
    if (hasJson) return jsonPath;
    if (hasLog) return logPath;
  } else {
    if (hasLog) return logPath;
    if (hasJson) return jsonPath;
  }

  return null;
}

async function readSummary(
  filePath: string,
  sinceMs: number
): Promise<{
  windowMs: number;
  total: number;
  bySeverity: { info: number; warn: number; error: number };
  byType: Record<string, number>;
}> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const cutoff = Date.now() - sinceMs;
  const counts = { total: 0, info: 0, warn: 0, error: 0 };
  const byType: Record<string, number> = {};

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as MonitorEvent;
      if (!event.ts) continue;
      const ts = new Date(event.ts).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;
      const count = event.count ?? 1;
      counts.total += count;
      if (event.severity) {
        counts[event.severity] += count;
      }
      const type = event.type ?? "event";
      byType[type] = (byType[type] ?? 0) + count;
    } catch {
      // ignore parse errors
    }
  }

  return { windowMs: sinceMs, total: counts.total, bySeverity: counts, byType };
}

function printSummaryConsole(summary: {
  windowMs: number;
  total: number;
  bySeverity: { info: number; warn: number; error: number };
  byType: Record<string, number>;
}): void {
  const seconds = Math.round(summary.windowMs / 1000);
  const topTypes = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");

  console.log(`Summary (last ${seconds}s)`);
  console.log(`  total=${summary.total}`);
  console.log(`  error=${summary.bySeverity.error} warn=${summary.bySeverity.warn} info=${summary.bySeverity.info}`);
  if (topTypes) {
    console.log(`  top=${topTypes}`);
  }
}

async function readStats(filePath: string, sinceMs: number) {
  const lines = (await fs.readFile(filePath, "utf-8")).split("\n").filter(Boolean);
  const cutoff = Date.now() - sinceMs;
  const s = { http: [0, 0, 0], mcp: [0, 0, 0], guard: 0, cacheHit: 0, cacheMiss: 0, build: [0, 0] };
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as MonitorEvent;
      if (!ev.ts || new Date(ev.ts).getTime() < cutoff) continue;
      const t = ev.type ?? "", dur = (ev.data?.durationMs as number) ?? 0;
      if (t.startsWith("http")) { s.http[0]++; s.http[1] += dur; if (ev.severity === "error") s.http[2]++; }
      else if (t.startsWith("mcp") || t.startsWith("tool.")) { s.mcp[0]++; s.mcp[1] += dur; if (t === "tool.error" || ev.severity === "error") s.mcp[2]++; }
      else if (t.startsWith("guard")) s.guard++;
      else if (t.startsWith("cache")) { if (ev.data?.hit) s.cacheHit++; else s.cacheMiss++; }
      else if (t.startsWith("build")) { s.build[0]++; s.build[1] += dur; }
    } catch { /* skip */ }
  }
  const avg = (tot: number, n: number) => n > 0 ? Math.round(tot / n) : 0;
  const ct = s.cacheHit + s.cacheMiss;
  return { windowMs: sinceMs, http: { requests: s.http[0], avgMs: avg(s.http[1], s.http[0]), errors: s.http[2] },
    mcp: { calls: s.mcp[0], avgMs: avg(s.mcp[1], s.mcp[0]), failures: s.mcp[2] }, guard: { violations: s.guard },
    cache: { hits: s.cacheHit, misses: s.cacheMiss, hitRate: ct > 0 ? `${Math.round((s.cacheHit / ct) * 100)}%` : "N/A" },
    build: { rebuilds: s.build[0], avgMs: avg(s.build[1], s.build[0]) } };
}

function printStats(st: Awaited<ReturnType<typeof readStats>>): void {
  const mins = Math.round(st.windowMs / 60000);
  console.log(`\nActivity Summary (last ${mins} minute${mins !== 1 ? "s" : ""})\n`);
  console.log(`  HTTP:    ${st.http.requests} requests, avg ${st.http.avgMs}ms, ${st.http.errors} errors`);
  console.log(`  MCP:     ${st.mcp.calls} tool calls, avg ${st.mcp.avgMs}ms, ${st.mcp.failures} failures`);
  console.log(`  Guard:   ${st.guard.violations} violation${st.guard.violations !== 1 ? "s" : ""}`);
  console.log(`  Cache:   ${st.cache.hitRate} hit rate (${st.cache.hits}/${st.cache.hits + st.cache.misses} entries)`);
  console.log(`  Build:   ${st.build.rebuilds} rebuild${st.build.rebuilds !== 1 ? "s" : ""}, avg ${st.build.avgMs}ms\n`);
}

function outputChunk(
  chunk: string,
  isJson: boolean,
  output: MonitorOutput,
  filters?: MonitorOptions
): void {
  if (!isJson || output === "json") {
    process.stdout.write(chunk);
    return;
  }

  const lines = chunk.split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as MonitorEvent;
      if (filters && !shouldShow(event, filters)) continue;
      const formatted = formatEventForConsole(event);
      process.stdout.write(`${formatted}\n`);
    } catch {
      process.stdout.write(`${line}\n`);
    }
  }
}

async function followFile(
  filePath: string,
  isJson: boolean,
  output: MonitorOutput,
  startAtEnd: boolean,
  filters?: MonitorOptions
): Promise<void> {
  let position = 0;
  let buffer = "";

  try {
    const stat = await fs.stat(filePath);
    position = startAtEnd ? stat.size : 0;
  } catch {
    position = 0;
  }

  const fd = await fs.open(filePath, "r");

  fsSync.watchFile(
    filePath,
    { interval: 500 },
    async (curr) => {
      if (curr.size < position) {
        position = 0;
        buffer = "";
      }
      if (curr.size === position) {
        return;
      }

      const length = curr.size - position;
      const chunk = Buffer.alloc(length);
      await fd.read(chunk, 0, length, position);
      position = curr.size;
      buffer += chunk.toString("utf-8");

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length > 0) {
        outputChunk(lines.join("\n"), isJson, output, filters);
      }
    }
  );
}

export async function monitor(options: MonitorOptions = {}): Promise<boolean> {
  const rootDir = resolveFromCwd(".");
  const resolved = resolveOutputFormat();
  const output: MonitorOutput = resolved === "json" || resolved === "agent" ? "json" : "console";
  const filePath = await resolveLogFile(rootDir, output, options.file);

  if (!filePath) {
    console.error("❌ Activity log file not found (.mandu/activity.log or activity.jsonl)");
    return false;
  }

  const isJson = filePath.endsWith(".jsonl");
  const follow = options.follow !== false;

  const windowMs = parseDuration(options.since) ?? 5 * 60 * 1000;

  if (options.stats) {
    if (!isJson) {
      console.error("Stats require JSON logs (activity.jsonl)");
      return false;
    }
    const st = await readStats(filePath, windowMs);
    if (output === "json") {
      console.log(JSON.stringify(st, null, 2));
    } else {
      printStats(st);
    }
    return true;
  }

  if (options.summary) {
    if (!isJson) {
      console.error("Summary is only available for JSON logs (activity.jsonl)");
    } else {
      const summary = await readSummary(filePath, windowMs);
      if (output === "json") {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        printSummaryConsole(summary);
      }
    }
    if (!follow) return true;
  }

  if (!follow) {
    const content = await fs.readFile(filePath, "utf-8");
    outputChunk(content, isJson, output, options);
    return true;
  }

  await followFile(filePath, isJson, output, true, options);
  return new Promise(() => {});
}

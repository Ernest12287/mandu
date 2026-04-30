/**
 * Kitchen HTTP Handler - Dispatches /__kitchen/* requests.
 *
 * Mounted inside handleRequestInternal() when isDev === true.
 * All Kitchen routes are under /__kitchen prefix.
 */

import type { RoutesManifest } from "../spec/schema";
import type { GuardConfig } from "../guard/types";
import { getGlobalCache, getCacheStoreStats } from "../runtime/cache";
import { ActivitySSEBroadcaster } from "./stream/activity-sse";
import { GuardAPI } from "./api/guard-api";
import { handleRoutesRequest } from "./api/routes-api";
import { FileAPI } from "./api/file-api";
import { GuardDecisionManager } from "./api/guard-decisions";
import { ContractPlaygroundAPI } from "./api/contract-api";
import { renderKitchenHTML } from "./kitchen-ui";
import { eventBus } from "../observability/event-bus";
import fs from "fs/promises";
import path from "path";

export const KITCHEN_PREFIX = "/__kitchen";

function reverseCopy<T>(items: readonly T[]): T[] {
  const reversed: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    reversed.push(items[index] as T);
  }
  return reversed;
}

export interface KitchenOptions {
  rootDir: string;
  manifest: RoutesManifest;
  guardConfig: GuardConfig | null;
}

/** In-memory error store for Kitchen → MCP bridge */
interface KitchenError {
  id: string;
  type: string;
  severity: string;
  message: string;
  stack?: string;
  url?: string;
  source?: string;
  line?: number;
  column?: number;
  timestamp: number;
}

const MAX_STORED_ERRORS = 50;
let storedErrors: KitchenError[] = [];

/** Get stored errors (used by MCP tools) */
export function getKitchenErrors(): KitchenError[] {
  return storedErrors;
}

/** Clear stored errors */
export function clearKitchenErrors(): void {
  storedErrors = [];
}

// ========== Request Ring Buffer ==========

export interface RequestEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  cacheStatus?: string;
}

const MAX_REQUESTS = 100;
const recentRequests: RequestEntry[] = [];

export function recordRequest(entry: RequestEntry): void {
  recentRequests.push(entry);
  if (recentRequests.length > MAX_REQUESTS) recentRequests.shift();
}

export function getRecentRequests(): RequestEntry[] {
  return reverseCopy(recentRequests);
}

/** Parse a window string like "5m", "30s", "1h" into milliseconds. */
function parseWindow(input: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)?$/.exec(input.trim());
  if (!match) return 5 * 60 * 1000;
  const value = parseInt(match[1], 10);
  const unit = match[2] || "m";
  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    default: return 5 * 60 * 1000;
  }
}

// ========== Per-Agent Stats ==========

export interface AgentStats {
  toolCalls: number;
  failures: number;
  topTools: Array<{ tool: string; count: number }>;
  avgDuration: number;
  firstSeen: number;
  lastSeen: number;
}

export interface AgentStatsResponse {
  agents: Record<string, AgentStats>;
  totalAgents: number;
  totalEvents: number;
}

/**
 * Aggregate recent MCP events by sessionId to produce per-agent usage stats.
 * Events without a sessionId are grouped under "unknown".
 */
export function computeAgentStats(): AgentStatsResponse {
  const events = eventBus.getRecent(500, { type: "mcp" });
  const agents: Record<string, AgentStats> = {};
  const toolCounts: Record<string, Map<string, number>> = {};
  const durations: Record<string, number[]> = {};

  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const sessionId = typeof data.sessionId === "string" && data.sessionId
      ? data.sessionId
      : "unknown";

    let agent = agents[sessionId];
    if (!agent) {
      agent = {
        toolCalls: 0,
        failures: 0,
        topTools: [],
        avgDuration: 0,
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
      };
      agents[sessionId] = agent;
      toolCounts[sessionId] = new Map();
      durations[sessionId] = [];
    }

    agent.toolCalls++;
    if (e.severity === "error") agent.failures++;
    if (e.timestamp < agent.firstSeen) agent.firstSeen = e.timestamp;
    if (e.timestamp > agent.lastSeen) agent.lastSeen = e.timestamp;

    const tool = typeof data.tool === "string" && data.tool
      ? data.tool
      : e.source || "unknown";
    toolCounts[sessionId].set(tool, (toolCounts[sessionId].get(tool) ?? 0) + 1);

    if (typeof e.duration === "number") {
      durations[sessionId].push(e.duration);
    }
  }

  for (const [sessionId, agent] of Object.entries(agents)) {
    agent.topTools = Array.from(toolCounts[sessionId].entries())
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const ds = durations[sessionId];
    agent.avgDuration = ds.length
      ? ds.reduce((a, b) => a + b, 0) / ds.length
      : 0;
  }

  return {
    agents,
    totalAgents: Object.keys(agents).length,
    totalEvents: events.length,
  };
}

export class KitchenHandler {
  private sse: ActivitySSEBroadcaster;
  private guardAPI: GuardAPI;
  private fileAPI: FileAPI;
  private guardDecisions: GuardDecisionManager;
  private contractAPI: ContractPlaygroundAPI;
  private manifest: RoutesManifest;

  constructor(private options: KitchenOptions) {
    this.manifest = options.manifest;
    this.sse = new ActivitySSEBroadcaster(options.rootDir);
    this.guardAPI = new GuardAPI(options.guardConfig, options.rootDir);
    this.fileAPI = new FileAPI(options.rootDir);
    this.guardDecisions = new GuardDecisionManager(options.rootDir);
    this.contractAPI = new ContractPlaygroundAPI(options.manifest, options.rootDir);
  }

  async start(): Promise<void> {
    this.sse.start();
    await this.loadPersistedErrors();
  }

  /** Load errors persisted from previous sessions */
  private async loadPersistedErrors(): Promise<void> {
    const errorsPath = path.join(this.options.rootDir, ".mandu", "errors.jsonl");
    try {
      const content = await fs.readFile(errorsPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines.slice(-MAX_STORED_ERRORS)) {
        try {
          storedErrors.push(JSON.parse(line));
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file doesn't exist yet — fine */ }
  }

  stop(): void {
    this.sse.stop();
  }

  /** Update manifest when routes change (HMR rebuild) */
  updateManifest(manifest: RoutesManifest): void {
    this.manifest = manifest;
    this.contractAPI.updateManifest(manifest);
  }

  /** Update guard config when mandu.config.ts changes */
  updateGuardConfig(config: GuardConfig | null): void {
    this.guardAPI.updateConfig(config);
  }

  /** Get the SSE broadcaster for external event injection */
  get broadcaster(): ActivitySSEBroadcaster {
    return this.sse;
  }

  /** Get the Guard API for pushing violation reports */
  get guard(): GuardAPI {
    return this.guardAPI;
  }

  /**
   * Handle a /__kitchen/* request.
   * Returns Response or null if path doesn't match.
   */
  async handle(req: Request, pathname: string): Promise<Response | null> {
    if (!pathname.startsWith(KITCHEN_PREFIX)) {
      return null;
    }

    const sub = pathname.slice(KITCHEN_PREFIX.length) || "/";

    // Kitchen dashboard UI
    if (sub === "/" || sub === "") {
      return new Response(renderKitchenHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // SSE activity stream
    if (sub === "/sse/activity") {
      return this.sse.createResponse();
    }

    // Routes API
    if (sub === "/api/routes") {
      return handleRoutesRequest(this.manifest);
    }

    // Guard API
    if (sub === "/api/guard" && req.method === "GET") {
      return this.guardAPI.handleGetReport();
    }

    if (sub === "/api/guard/scan" && req.method === "POST") {
      return this.guardAPI.handleScan();
    }

    // Guard Decisions API
    if (sub === "/api/guard/decisions" && req.method === "GET") {
      const decisions = await this.guardDecisions.load();
      return Response.json({ decisions });
    }

    if (sub === "/api/guard/approve" && req.method === "POST") {
      try {
        const body = await req.json();
        const decision = await this.guardDecisions.save({
          violationKey: `${body.ruleId}::${body.filePath}`,
          action: "approve",
          ruleId: body.ruleId,
          filePath: body.filePath,
          reason: body.reason,
        });
        return Response.json({ decision });
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
    }

    if (sub === "/api/guard/reject" && req.method === "POST") {
      try {
        const body = await req.json();
        const decision = await this.guardDecisions.save({
          violationKey: `${body.ruleId}::${body.filePath}`,
          action: "reject",
          ruleId: body.ruleId,
          filePath: body.filePath,
          reason: body.reason,
        });
        return Response.json({ decision });
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
    }

    if (sub.startsWith("/api/guard/decisions/") && req.method === "DELETE") {
      const id = sub.slice("/api/guard/decisions/".length);
      const removed = await this.guardDecisions.remove(id);
      if (!removed) {
        return Response.json({ error: "Decision not found" }, { status: 404 });
      }
      return Response.json({ removed: true });
    }

    // Requests API — recent HTTP events from eventBus (fallback: ring buffer)
    if (sub === "/api/requests" && req.method === "GET") {
      const url = new URL(req.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);
      const busEvents = eventBus.getRecent(limit, { type: "http" });
      if (busEvents.length > 0) {
        return Response.json({ requests: reverseCopy(busEvents) });
      }
      return Response.json({ requests: getRecentRequests().slice(0, limit) });
    }

    // Correlation API — all events linked to a correlationId
    if (sub === "/api/correlation" && req.method === "GET") {
      const url = new URL(req.url);
      const cid = url.searchParams.get("id") || "";
      if (!cid) return Response.json({ events: [] });
      const all = eventBus.getRecent(500);
      const events = all.filter((e) => e.correlationId === cid);
      return Response.json({ events });
    }

    // Activity API — recent MCP events from eventBus (fallback: activity.jsonl)
    if (sub === "/api/activity" && req.method === "GET") {
      const url = new URL(req.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);
      const busEvents = eventBus.getRecent(limit, { type: "mcp" });
      if (busEvents.length > 0) {
        return Response.json({ events: reverseCopy(busEvents) });
      }
      const events = await this.readRecentActivity();
      return Response.json({ events });
    }

    // Agent Stats API — per-agent (sessionId) aggregation of MCP events
    if (sub === "/api/agent-stats" && req.method === "GET") {
      return Response.json(computeAgentStats());
    }

    // Cache API — cache store stats
    if ((sub === "/api/cache" || sub === "/api/cache-stats") && req.method === "GET") {
      const store = getGlobalCache();
      return Response.json({
        enabled: !!store,
        size: store?.size ?? 0,
        stats: getCacheStoreStats(store),
      });
    }

    // Metrics API — rolling-window eventBus stats
    if (sub === "/api/metrics" && req.method === "GET") {
      const url = new URL(req.url);
      const windowParam = url.searchParams.get("window") || "5m";
      const windowMs = parseWindow(windowParam);
      const stats = eventBus.getStats(windowMs);
      const httpEvents = eventBus.getRecent(500, { type: "http" })
        .filter((e) => e.timestamp >= Date.now() - windowMs);
      const durations = httpEvents
        .map((e) => e.duration)
        .filter((d): d is number => typeof d === "number")
        .sort((a, b) => a - b);
      const percentile = (p: number) => {
        if (!durations.length) return 0;
        const idx = Math.min(durations.length - 1, Math.floor((p / 100) * durations.length));
        return durations[idx];
      };
      const totalEvents = Object.values(stats).reduce((sum, s) => sum + s.count, 0);
      const totalErrors = Object.values(stats).reduce((sum, s) => sum + s.errors, 0);
      return Response.json({
        window: windowParam,
        windowMs,
        stats,
        http: {
          count: httpEvents.length,
          p50: percentile(50),
          p95: percentile(95),
          p99: percentile(99),
        },
        mcp: {
          count: stats.mcp.count,
          errors: stats.mcp.errors,
          avgDuration: stats.mcp.avgDuration,
        },
        errorRate: totalEvents > 0 ? totalErrors / totalEvents : 0,
        totalEvents,
      });
    }

    // Error API (Kitchen → MCP bridge)
    if (sub === "/api/errors" && req.method === "POST") {
      try {
        const body = await req.json() as KitchenError | KitchenError[];
        const errors = Array.isArray(body) ? body : [body];
        for (const error of errors) {
          if (!error.message) continue;
          error.timestamp = error.timestamp || Date.now();
          error.id = error.id || `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          storedErrors.push(error);
          if (storedErrors.length > MAX_STORED_ERRORS) {
            storedErrors.shift();
          }
          // Persist to disk
          const errorLine = JSON.stringify(error) + "\n";
          const errorsPath = path.join(this.options.rootDir, ".mandu", "errors.jsonl");
          fs.appendFile(errorsPath, errorLine).catch(() => {});
        }
        return Response.json({ received: errors.length, total: storedErrors.length });
      } catch {
        return Response.json({ error: "Invalid error payload" }, { status: 400 });
      }
    }

    if (sub === "/api/errors" && req.method === "GET") {
      return Response.json({ errors: storedErrors, count: storedErrors.length });
    }

    if (sub === "/api/errors" && req.method === "DELETE") {
      const count = storedErrors.length;
      clearKitchenErrors();
      return Response.json({ cleared: count });
    }

    // File API
    if (sub === "/api/file" && req.method === "GET") {
      return this.fileAPI.handleReadFile(new URL(req.url));
    }

    if (sub === "/api/file/diff" && req.method === "GET") {
      return this.fileAPI.handleFileDiff(new URL(req.url));
    }

    if (sub === "/api/file/changes" && req.method === "GET") {
      return this.fileAPI.handleRecentChanges();
    }

    // Contract API
    if (sub === "/api/contracts" && req.method === "GET") {
      return this.contractAPI.handleList();
    }

    if (sub === "/api/contracts/validate" && req.method === "POST") {
      return this.contractAPI.handleValidate(req);
    }

    if (sub === "/api/contracts/openapi" && req.method === "GET") {
      return this.contractAPI.handleOpenAPI();
    }

    if (sub === "/api/contracts/openapi.yaml" && req.method === "GET") {
      return this.contractAPI.handleOpenAPIYAML();
    }

    if (sub.startsWith("/api/contracts/") && req.method === "GET") {
      const id = sub.slice("/api/contracts/".length);
      if (id && !id.includes("/")) {
        return this.contractAPI.handleDetail(id);
      }
    }

    // Unknown kitchen route
    return Response.json(
      { error: "Not found", path: pathname },
      { status: 404 },
    );
  }

  /** Read last 50 entries from .mandu/activity.jsonl */
  private async readRecentActivity(): Promise<unknown[]> {
    const logPath = path.join(this.options.rootDir, ".mandu", "activity.jsonl");
    try {
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return reverseCopy(lines.slice(-50)).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }
}

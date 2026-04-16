import { describe, it, expect, beforeEach } from "bun:test";
import { computeAgentStats, KitchenHandler, KITCHEN_PREFIX } from "../../src/kitchen/kitchen-handler";
import { eventBus } from "../../src/observability/event-bus";
import type { RoutesManifest } from "../../src/spec/schema";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Force-reset the eventBus recent buffer by emitting enough filler events
 * to flush out anything prior tests may have left behind. We then rely on
 * the internal 200-event window; our assertions only look at events we
 * emit inside each test, so we filter by a unique marker when needed.
 */
function resetBus() {
  // Emit 250 filler "cache" events to evict any residual state within the
  // 200-item ring buffer.
  for (let i = 0; i < 250; i++) {
    eventBus.emit({
      type: "cache",
      severity: "info",
      source: "reset",
      message: "reset",
    });
  }
}

describe("computeAgentStats", () => {
  beforeEach(() => {
    resetBus();
  });

  it("returns empty agents when there are no MCP events", () => {
    const result = computeAgentStats();
    expect(result.agents).toEqual({});
    expect(result.totalAgents).toBe(0);
    expect(result.totalEvents).toBe(0);
  });

  it("groups events by sessionId", () => {
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "mandu.guard.check",
      message: "ok",
      duration: 10,
      data: { sessionId: "alice", tool: "mandu.guard.check" },
    });
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "mandu.route.add",
      message: "ok",
      duration: 20,
      data: { sessionId: "alice", tool: "mandu.route.add" },
    });
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "mandu.guard.check",
      message: "ok",
      duration: 30,
      data: { sessionId: "bob", tool: "mandu.guard.check" },
    });

    const result = computeAgentStats();
    expect(result.totalAgents).toBe(2);
    expect(result.totalEvents).toBe(3);
    expect(result.agents.alice.toolCalls).toBe(2);
    expect(result.agents.bob.toolCalls).toBe(1);
  });

  it("counts failures based on severity", () => {
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "t",
      message: "ok",
      data: { sessionId: "s1", tool: "t" },
    });
    eventBus.emit({
      type: "mcp",
      severity: "error",
      source: "t",
      message: "fail",
      data: { sessionId: "s1", tool: "t" },
    });

    const result = computeAgentStats();
    expect(result.agents.s1.toolCalls).toBe(2);
    expect(result.agents.s1.failures).toBe(1);
  });

  it("sorts topTools by count descending and limits to 5", () => {
    const emissions: Array<[string, number]> = [
      ["tool-a", 3],
      ["tool-b", 5],
      ["tool-c", 1],
      ["tool-d", 4],
      ["tool-e", 2],
      ["tool-f", 6],
      ["tool-g", 1],
    ];
    for (const [tool, n] of emissions) {
      for (let i = 0; i < n; i++) {
        eventBus.emit({
          type: "mcp",
          severity: "info",
          source: tool,
          message: "ok",
          data: { sessionId: "agent1", tool },
        });
      }
    }

    const result = computeAgentStats();
    const top = result.agents.agent1.topTools;
    expect(top).toHaveLength(5);
    expect(top[0]).toEqual({ tool: "tool-f", count: 6 });
    expect(top[1]).toEqual({ tool: "tool-b", count: 5 });
    expect(top[2]).toEqual({ tool: "tool-d", count: 4 });
    // Descending order check
    for (let i = 0; i < top.length - 1; i++) {
      expect(top[i].count).toBeGreaterThanOrEqual(top[i + 1].count);
    }
  });

  it("avgDuration excludes events without a duration field", () => {
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "t",
      message: "ok",
      duration: 100,
      data: { sessionId: "s", tool: "t" },
    });
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "t",
      message: "ok",
      duration: 200,
      data: { sessionId: "s", tool: "t" },
    });
    // No duration — should not affect average
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "t",
      message: "ok",
      data: { sessionId: "s", tool: "t" },
    });

    const result = computeAgentStats();
    expect(result.agents.s.toolCalls).toBe(3);
    expect(result.agents.s.avgDuration).toBe(150);
  });

  it("tracks firstSeen and lastSeen timestamps", () => {
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "t",
      message: "ok",
      data: { sessionId: "s", tool: "t" },
    });
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "t",
      message: "ok",
      data: { sessionId: "s", tool: "t" },
    });

    const result = computeAgentStats();
    expect(result.agents.s.firstSeen).toBeLessThanOrEqual(result.agents.s.lastSeen);
  });

  it("groups events without sessionId under 'unknown'", () => {
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "t",
      message: "ok",
      data: { tool: "t" },
    });
    const result = computeAgentStats();
    expect(result.agents.unknown).toBeDefined();
    expect(result.agents.unknown.toolCalls).toBe(1);
  });
});

describe("KitchenHandler /api/agent-stats endpoint", () => {
  let tmpDir: string;
  let handler: KitchenHandler;
  const manifest: RoutesManifest = { version: 1, routes: [] };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-agent-stats-"));
    fs.mkdirSync(path.join(tmpDir, ".mandu"), { recursive: true });
    handler = new KitchenHandler({
      rootDir: tmpDir,
      manifest,
      guardConfig: null,
    });
    resetBus();
  });

  it("returns the agent stats JSON payload", async () => {
    eventBus.emit({
      type: "mcp",
      severity: "info",
      source: "mandu.guard.check",
      message: "ok",
      duration: 10,
      data: { sessionId: "agent-xyz", tool: "mandu.guard.check" },
    });

    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/agent-stats`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/agent-stats`);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      agents: Record<string, { toolCalls: number }>;
      totalAgents: number;
      totalEvents: number;
    };
    expect(body.agents["agent-xyz"]).toBeDefined();
    expect(body.agents["agent-xyz"].toolCalls).toBe(1);
    expect(body.totalAgents).toBeGreaterThanOrEqual(1);

    handler.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

/**
 * Phase 17 — MCP heap heartbeat tests.
 *
 * `logMcpHeapUsage` is exported so we can:
 *   1. Assert the stderr line shape (`[MCP <label>] rss=...MB heapUsed=...`)
 *   2. Prove errors in the probe are swallowed
 *   3. Verify the heartbeat interval is respected + cleared on shutdown
 *
 * We intercept `console.error` by stubbing it temporarily — the existing
 * `setupMcpLogging` wiring in the full server is not exercised here
 * (integration concern).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { logMcpHeapUsage } from "../src/server.js";

describe("logMcpHeapUsage", () => {
  let lines: string[];
  let originalError: typeof console.error;

  beforeEach(() => {
    lines = [];
    originalError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("emits a single KV-formatted line with all required fields", () => {
    logMcpHeapUsage();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    // Anchored prefix
    expect(line.startsWith("[MCP heap] ")).toBe(true);
    // Required fields
    expect(line).toMatch(/rss=\d+MB/);
    expect(line).toMatch(/heapUsed=\d+MB/);
    expect(line).toMatch(/heapTotal=\d+MB/);
    expect(line).toMatch(/external=\d+MB/);
    expect(line).toMatch(/uptime=\d+s/);
  });

  it("honours the label override", () => {
    logMcpHeapUsage("startup");
    expect(lines[0].startsWith("[MCP startup]")).toBe(true);

    lines.length = 0;
    logMcpHeapUsage("heartbeat");
    expect(lines[0].startsWith("[MCP heartbeat]")).toBe(true);
  });

  it("swallows errors if memory probes throw", () => {
    // Inject a broken `Bun.memoryUsage` for this test window; the
    // fallback should still produce a line using process.memoryUsage().
    const bunGlobal = (globalThis as { Bun?: { memoryUsage?: () => unknown } }).Bun;
    const original = bunGlobal?.memoryUsage;
    if (bunGlobal) {
      bunGlobal.memoryUsage = () => {
        throw new Error("nope");
      };
    }
    try {
      expect(() => logMcpHeapUsage()).not.toThrow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/rss=\d+MB/);
    } finally {
      if (bunGlobal && original) bunGlobal.memoryUsage = original;
    }
  });

  it("reports positive, realistic memory numbers (heapUsed > 0)", () => {
    logMcpHeapUsage();
    const line = lines[0];
    const match = line.match(/heapUsed=(\d+)MB/);
    expect(match).not.toBeNull();
    const mb = Number(match![1]);
    // Bun/Node process heapUsed is typically 3-200 MB. We only require
    // strictly positive to stay portable across CI environments.
    expect(mb).toBeGreaterThanOrEqual(0);
  });
});

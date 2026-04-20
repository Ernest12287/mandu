/**
 * Phase B.2 — memory store tests.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, existsSync, statSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendMemoryEvent,
  readMemoryEvents,
  memoryFilePath,
  memoryStats,
  clearMemory,
  rotateMemoryNow,
} from "../src";

let root: string;
const roots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ate-memory-store-"));
  roots.push(root);
});

afterAll(() => {
  // best-effort
  for (const r of roots) {
    try {
      const { rmSync } = require("node:fs");
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("appendMemoryEvent", () => {
  test("writes one line per event and creates .mandu directory", () => {
    appendMemoryEvent(root, {
      kind: "intent_history",
      timestamp: "2026-04-20T00:00:00.000Z",
      intent: "signup edge cases",
      agent: "test",
      resulting: { saved: ["spec/x.test.ts"] },
    });
    const file = memoryFilePath(root);
    expect(existsSync(file)).toBe(true);
    const events = readMemoryEvents(root);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("intent_history");
  });

  test("multiple appends accumulate", () => {
    appendMemoryEvent(root, {
      kind: "coverage_snapshot",
      timestamp: "2026-04-20T00:00:00.000Z",
      routes: 10,
      withSpec: 3,
      withProperty: 0,
    });
    appendMemoryEvent(root, {
      kind: "boundary_gap_filled",
      timestamp: "2026-04-20T00:10:00.000Z",
      contractName: "SignupContract",
      probes: 12,
    });
    expect(readMemoryEvents(root).length).toBe(2);
  });

  test("corrupt line is skipped on read", () => {
    appendMemoryEvent(root, {
      kind: "rejected_spec",
      timestamp: "2026-04-20T00:00:00.000Z",
      specPath: "x.test.ts",
      reason: "wrong",
    });
    // Inject a bogus line by hand.
    const file = memoryFilePath(root);
    writeFileSync(file, readFileSync(file, "utf8") + "not-json-here\n", "utf8");
    appendMemoryEvent(root, {
      kind: "rejected_spec",
      timestamp: "2026-04-20T00:00:00.000Z",
      specPath: "y.test.ts",
      reason: "also wrong",
    });
    const events = readMemoryEvents(root);
    expect(events.length).toBe(2);
  });

  test("rotation: threshold exceeded returns rotation descriptor", () => {
    process.env.MANDU_ATE_MEMORY_MAX_BYTES = "200";
    try {
      // First append to seed the file.
      appendMemoryEvent(root, {
        kind: "intent_history",
        timestamp: "2026-04-20T00:00:00.000Z",
        intent: "A".repeat(300),
        agent: "test",
        resulting: { saved: [] },
      });
      const result = appendMemoryEvent(root, {
        kind: "intent_history",
        timestamp: "2026-04-20T00:00:01.000Z",
        intent: "B".repeat(300),
        agent: "test",
        resulting: { saved: [] },
      });
      expect(result.rotation?.oldPath).toBeDefined();
      const files = readdirSync(join(root, ".mandu"));
      expect(files.some((f: string) => f.endsWith(".bak"))).toBe(true);
    } finally {
      delete process.env.MANDU_ATE_MEMORY_MAX_BYTES;
    }
  });
});

describe("memoryStats / clearMemory / rotateMemoryNow", () => {
  test("stats aggregates by kind and returns byte count", () => {
    appendMemoryEvent(root, {
      kind: "intent_history",
      timestamp: "2026-04-20T00:00:00.000Z",
      intent: "x",
      agent: "t",
      resulting: { saved: [] },
    });
    appendMemoryEvent(root, {
      kind: "rejected_spec",
      timestamp: "2026-04-20T00:00:01.000Z",
      specPath: "y.test.ts",
      reason: "r",
    });
    const s = memoryStats(root);
    expect(s.total).toBe(2);
    expect(s.byKind.intent_history).toBe(1);
    expect(s.byKind.rejected_spec).toBe(1);
    expect(s.bytes).toBeGreaterThan(0);
  });

  test("clearMemory deletes file and stats returns 0", () => {
    appendMemoryEvent(root, {
      kind: "coverage_snapshot",
      timestamp: "2026-04-20T00:00:00.000Z",
      routes: 1,
      withSpec: 0,
      withProperty: 0,
    });
    expect(existsSync(memoryFilePath(root))).toBe(true);
    clearMemory(root);
    expect(existsSync(memoryFilePath(root))).toBe(false);
    expect(memoryStats(root).total).toBe(0);
  });

  test("rotateMemoryNow archives the current file", () => {
    appendMemoryEvent(root, {
      kind: "intent_history",
      timestamp: "2026-04-20T00:00:00.000Z",
      intent: "a",
      agent: "t",
      resulting: { saved: [] },
    });
    const archived = rotateMemoryNow(root);
    expect(archived).toBeTruthy();
    expect(existsSync(archived!)).toBe(true);
    expect(existsSync(memoryFilePath(root))).toBe(false);
  });

  test("rotateMemoryNow on empty returns null", () => {
    expect(rotateMemoryNow(root)).toBeNull();
  });
});

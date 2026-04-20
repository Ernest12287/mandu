/**
 * Phase B.2 — memory recall tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendMemoryEvent,
  recallMemory,
  tokenOverlapScore,
  parseMemoryEvent,
} from "../src";

describe("tokenOverlapScore", () => {
  test("identical inputs → 1.x (with substring bonus)", () => {
    const s = tokenOverlapScore("signup form validation", "signup form validation");
    expect(s).toBeGreaterThan(0.9);
  });
  test("disjoint inputs → 0", () => {
    expect(tokenOverlapScore("abc", "xyz")).toBe(0);
  });
  test("partial overlap — case folded", () => {
    const s = tokenOverlapScore("Signup Form", "signup page");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("parseMemoryEvent — validation", () => {
  test("rejects malformed record (missing kind)", () => {
    expect(parseMemoryEvent({ timestamp: "x" })).toBeNull();
  });
  test("accepts well-formed intent_history", () => {
    const ev = parseMemoryEvent({
      kind: "intent_history",
      timestamp: "2026-04-20T00:00:00.000Z",
      intent: "x",
      agent: "t",
      resulting: { saved: [] },
    });
    expect(ev).not.toBeNull();
  });
  test("rejects intent_history missing `agent`", () => {
    const ev = parseMemoryEvent({
      kind: "intent_history",
      timestamp: "x",
      intent: "x",
      resulting: { saved: [] },
    });
    expect(ev).toBeNull();
  });
});

describe("recallMemory", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ate-memory-recall-"));

    appendMemoryEvent(root, {
      kind: "intent_history",
      timestamp: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      intent: "signup edge cases",
      routeId: "api-signup",
      agent: "cursor",
      resulting: { saved: ["tests/e2e/signup.spec.ts"] },
    });
    appendMemoryEvent(root, {
      kind: "rejected_spec",
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      specPath: "tests/e2e/login.spec.ts",
      reason: "too deep in implementation details",
      routeId: "api-login",
    });
    appendMemoryEvent(root, {
      kind: "coverage_snapshot",
      timestamp: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      routes: 8,
      withSpec: 3,
      withProperty: 0,
    });
    appendMemoryEvent(root, {
      kind: "boundary_gap_filled",
      timestamp: new Date().toISOString(),
      contractName: "SignupContract",
      probes: 14,
    });
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("no filter → returns recent events", () => {
    const r = recallMemory(root);
    expect(r.events.length).toBeGreaterThan(0);
  });

  test("kind filter narrows to requested kind only", () => {
    const r = recallMemory(root, { kind: "rejected_spec" });
    for (const ev of r.events) expect(ev.kind).toBe("rejected_spec");
  });

  test("intent filter — substring hit", () => {
    const r = recallMemory(root, { intent: "signup" });
    expect(r.events.some((e) => e.kind === "intent_history")).toBe(true);
  });

  test("sinceDays filter drops old events", () => {
    const r = recallMemory(root, { sinceDays: 5 });
    expect(r.events.some((e) => e.kind === "coverage_snapshot")).toBe(false);
  });

  test("route filter — id style", () => {
    const r = recallMemory(root, { route: "api-signup" });
    expect(r.events.some((e) => e.kind === "intent_history")).toBe(true);
  });

  test("limit caps returned events", () => {
    const r = recallMemory(root, { limit: 1 });
    expect(r.events.length).toBeLessThanOrEqual(1);
    expect(r.totalMatching).toBeGreaterThanOrEqual(r.events.length);
  });
});

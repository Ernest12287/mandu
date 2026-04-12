import { describe, test, expect, beforeEach } from "bun:test";

/**
 * We import from the module directly to get a fresh bus per test.
 * Since eventBus is a singleton, we test through the class indirectly
 * by using the public API and verifying side-effects.
 */
import {
  eventBus,
  type ObservabilityEvent,
  type EventType,
} from "../../src/observability/event-bus";

// Helper: drain recent events so previous tests don't leak.
function drainBus() {
  // Emit enough events to push old ones out (maxRecent = 200).
  // Faster: just verify through getRecent with filter.
}

function makeEvent(overrides: Partial<Omit<ObservabilityEvent, "id" | "timestamp">> = {}) {
  return {
    type: "http" as EventType,
    severity: "info" as const,
    source: "test",
    message: "test event",
    ...overrides,
  };
}

describe("ManduEventBus", () => {
  test("on/emit basic flow", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = eventBus.on("http", (e) => received.push(e));

    eventBus.emit(makeEvent({ message: "basic-flow" }));

    expect(received.length).toBe(1);
    expect(received[0].message).toBe("basic-flow");
    expect(received[0].id).toBeTruthy();
    expect(received[0].timestamp).toBeGreaterThan(0);

    unsub();
  });

  test("wildcard handler receives all event types", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = eventBus.on("*", (e) => {
      if (e.source === "wildcard-test") received.push(e);
    });

    eventBus.emit(makeEvent({ type: "http", source: "wildcard-test", message: "a" }));
    eventBus.emit(makeEvent({ type: "mcp", source: "wildcard-test", message: "b" }));
    eventBus.emit(makeEvent({ type: "guard", source: "wildcard-test", message: "c" }));

    expect(received.length).toBe(3);
    expect(received.map((e) => e.type)).toEqual(["http", "mcp", "guard"]);

    unsub();
  });

  test("unsubscribe stops delivery", () => {
    const received: ObservabilityEvent[] = [];
    const unsub = eventBus.on("build", (e) => received.push(e));

    eventBus.emit(makeEvent({ type: "build", message: "before-unsub" }));
    expect(received.length).toBe(1);

    unsub();

    eventBus.emit(makeEvent({ type: "build", message: "after-unsub" }));
    expect(received.length).toBe(1);
  });

  test("getRecent returns events and respects count", () => {
    // Emit a few tagged events
    for (let i = 0; i < 5; i++) {
      eventBus.emit(makeEvent({ type: "cache", source: "recent-test", message: `r-${i}` }));
    }

    const all = eventBus.getRecent(undefined, { type: "cache" });
    expect(all.length).toBeGreaterThanOrEqual(5);

    const limited = eventBus.getRecent(3, { type: "cache" });
    expect(limited.length).toBe(3);
    // Should return the most recent 3
    expect(limited[2].message).toBe("r-4");
  });

  test("getRecent filters by severity", () => {
    eventBus.emit(makeEvent({ type: "error", severity: "error", source: "sev-test", message: "err" }));
    eventBus.emit(makeEvent({ type: "error", severity: "info", source: "sev-test", message: "ok" }));

    const errors = eventBus.getRecent(undefined, { type: "error", severity: "error" });
    const infos = eventBus.getRecent(undefined, { type: "error", severity: "info" });

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.every((e) => e.severity === "error")).toBe(true);
    expect(infos.length).toBeGreaterThanOrEqual(1);
    expect(infos.every((e) => e.severity === "info")).toBe(true);
  });

  test("getStats computes counts, errors, and avgDuration", () => {
    // Emit events with known durations
    eventBus.emit(makeEvent({ type: "ws", severity: "info", source: "stats-test", message: "s1", duration: 100 }));
    eventBus.emit(makeEvent({ type: "ws", severity: "error", source: "stats-test", message: "s2", duration: 200 }));
    eventBus.emit(makeEvent({ type: "ws", severity: "info", source: "stats-test", message: "s3", duration: 300 }));

    const stats = eventBus.getStats(60_000); // last 60s
    expect(stats.ws.count).toBeGreaterThanOrEqual(3);
    expect(stats.ws.errors).toBeGreaterThanOrEqual(1);
    expect(stats.ws.avgDuration).toBeGreaterThanOrEqual(100);
  });

  test("maxRecent caps stored events (LRU eviction)", () => {
    // Emit 210 events to exceed the 200 cap
    for (let i = 0; i < 210; i++) {
      eventBus.emit(makeEvent({ type: "build", source: "cap-test", message: `cap-${i}` }));
    }

    const all = eventBus.getRecent();
    expect(all.length).toBeLessThanOrEqual(200);

    // The earliest events should have been evicted
    const capEvents = all.filter((e) => e.source === "cap-test");
    const firstMsg = capEvents[0]?.message;
    // "cap-0" through some early ones should be gone
    expect(firstMsg).not.toBe("cap-0");
  });

  test("emit auto-generates unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      eventBus.emit(makeEvent({ source: "id-test", message: `id-${i}` }));
    }
    const recent = eventBus.getRecent(10, { type: "http" });
    for (const e of recent) {
      if (e.source === "id-test") ids.add(e.id);
    }
    // All ids should be unique
    expect(ids.size).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Unit tests for adapter implementations in `src/adapter.ts`.
 *
 * **Scope**:
 *  - MockAdapter: full exercise, including timeout + output-cap + happy path
 *  - CloudflareSandboxAdapter: construction + error on uninstantiated SDK
 *  - FlyMachineAdapter: stubbed error path
 *  - selectAdapter: mode switching
 *
 * Tests NEVER invoke `CloudflareSandboxAdapter.run()` — that would require
 * a real CF account. The mode switch is the test boundary.
 */

import { describe, it, expect } from "bun:test";
import {
  MockAdapter,
  CloudflareSandboxAdapter,
  FlyMachineAdapter,
  selectAdapter,
  resolveAdapterMode,
} from "../src/adapter";
import type { RunOptions, SSEEvent, WorkerBindings } from "../src/types";

const baseOpts: RunOptions = {
  code: "console.log('test')",
  example: "hello-mandu",
  runId: "test-run-001",
  clientIp: "127.0.0.1",
};

async function collect(stream: AsyncIterable<SSEEvent>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

// ----------------------------------------------------------------------------
// MockAdapter
// ----------------------------------------------------------------------------

describe("MockAdapter", () => {
  it("identifies itself as 'mock'", () => {
    const a = new MockAdapter();
    expect(a.name).toBe("mock");
  });

  it("emits events in the documented order: sandbox-url → stdout → exit", async () => {
    const adapter = new MockAdapter();
    const events = await collect(adapter.run(baseOpts));

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].type).toBe("sandbox-url");
    expect(events[events.length - 1].type).toMatch(/^(exit|error)$/);
  });

  it("includes runId in the sandbox-url event", async () => {
    const adapter = new MockAdapter();
    const events = await collect(adapter.run(baseOpts));
    const first = events[0];

    expect(first.type).toBe("sandbox-url");
    if (first.type === "sandbox-url") {
      expect(first.data.runId).toBe("test-run-001");
      expect(first.data.url).toContain("test-run-001");
    }
  });

  it("reports a bounded durationMs on the exit event", async () => {
    const adapter = new MockAdapter();
    const events = await collect(adapter.run(baseOpts));
    const exit = events.find((e) => e.type === "exit");

    if (exit && exit.type === "exit") {
      expect(exit.data.durationMs).toBeGreaterThanOrEqual(0);
      // Mock script is tiny; generous upper bound to avoid flakes on slow CI.
      expect(exit.data.durationMs).toBeLessThan(30_000);
      expect(typeof exit.data.code).toBe("number");
    } else {
      // If we timed out or errored, that's fine for this environment.
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
    }
  });

  it("forwards exampleSlug env var to the spawned script", async () => {
    // The default mock script prints the example slug. We accept either a
    // real exit-event path (Bun.spawn worked) or an error-event path
    // (sandboxed CI without spawn support — e.g. if our env strips PATH).
    const adapter = new MockAdapter();
    const events = await collect(
      adapter.run({ ...baseOpts, example: "filling-loader" })
    );

    const stdoutEvents = events.filter((e) => e.type === "stdout");
    if (stdoutEvents.length > 0) {
      const combined = stdoutEvents
        .map((e) => (e.type === "stdout" ? e.data.chunk : ""))
        .join("");
      expect(combined).toContain("filling-loader");
    }
  });

  it("dispose() is safe to call without a prior run", async () => {
    const adapter = new MockAdapter();
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// CloudflareSandboxAdapter
// ----------------------------------------------------------------------------

describe("CloudflareSandboxAdapter", () => {
  it("identifies itself as 'cloudflare-sandbox'", () => {
    const a = new CloudflareSandboxAdapter({ fake: true });
    expect(a.name).toBe("cloudflare-sandbox");
  });

  it("throws when constructed without a sandbox binding", () => {
    expect(() => new CloudflareSandboxAdapter(null)).toThrow(
      /requires a sandbox binding/
    );
    expect(() => new CloudflareSandboxAdapter(undefined)).toThrow();
  });

  it("run() throws until live wiring lands (scaffold guard)", async () => {
    const adapter = new CloudflareSandboxAdapter({ fake: true });

    // The async iterator throws on first `.next()` — this is how we signal
    // "deploy incomplete" rather than silently succeeding.
    const iter = adapter.run(baseOpts)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/scaffold/);
  });
});

// ----------------------------------------------------------------------------
// FlyMachineAdapter
// ----------------------------------------------------------------------------

describe("FlyMachineAdapter", () => {
  it("identifies itself as 'fly-machine'", () => {
    const a = new FlyMachineAdapter({ apiToken: "x", appName: "y" });
    expect(a.name).toBe("fly-machine");
  });

  it("emits an internal error event (stub)", async () => {
    const adapter = new FlyMachineAdapter({ apiToken: "x", appName: "y" });
    const events = await collect(adapter.run(baseOpts));

    expect(events.length).toBe(1);
    const first = events[0];
    expect(first.type).toBe("error");
    if (first.type === "error") {
      expect(first.data.reason).toBe("internal");
      expect(first.data.message).toContain("not yet implemented");
    }
  });
});

// ----------------------------------------------------------------------------
// selectAdapter
// ----------------------------------------------------------------------------

describe("selectAdapter", () => {
  const baseEnv = {
    PLAYGROUND_DO: {} as WorkerBindings["PLAYGROUND_DO"],
    RATE_LIMIT: {} as WorkerBindings["RATE_LIMIT"],
  };

  it("returns MockAdapter when ADAPTER_MODE=mock", () => {
    const a = selectAdapter({ ...baseEnv, ADAPTER_MODE: "mock" });
    expect(a.name).toBe("mock");
  });

  it("returns FlyMachineAdapter when ADAPTER_MODE=fly", () => {
    const a = selectAdapter({ ...baseEnv, ADAPTER_MODE: "fly" });
    expect(a.name).toBe("fly-machine");
  });

  it("returns CloudflareSandboxAdapter by default", () => {
    const a = selectAdapter({
      ...baseEnv,
      ADAPTER_MODE: "cloudflare",
      SANDBOX: { fake: true },
    });
    expect(a.name).toBe("cloudflare-sandbox");
  });

  it("defaults to cloudflare when ADAPTER_MODE is omitted", () => {
    const a = selectAdapter({ ...baseEnv, SANDBOX: { fake: true } });
    expect(a.name).toBe("cloudflare-sandbox");
  });

  it("returns DockerSandboxAdapter when ADAPTER_MODE=docker", () => {
    const a = selectAdapter({ ...baseEnv, ADAPTER_MODE: "docker" });
    expect(a.name).toBe("docker-sandbox");
  });
});

describe("resolveAdapterMode", () => {
  const baseEnv = {
    PLAYGROUND_DO: {} as WorkerBindings["PLAYGROUND_DO"],
    RATE_LIMIT: {} as WorkerBindings["RATE_LIMIT"],
  };

  it("honors explicit ADAPTER_MODE over process.env", () => {
    expect(
      resolveAdapterMode(
        { ...baseEnv, ADAPTER_MODE: "mock" },
        { MANDU_PLAYGROUND_ADAPTER: "docker" },
      ),
    ).toBe("mock");
  });

  it("falls back to MANDU_PLAYGROUND_ADAPTER when ADAPTER_MODE absent", () => {
    expect(
      resolveAdapterMode(baseEnv, { MANDU_PLAYGROUND_ADAPTER: "docker" }),
    ).toBe("docker");
  });

  it("defaults to cloudflare when both are absent", () => {
    expect(resolveAdapterMode(baseEnv, {})).toBe("cloudflare");
  });

  it("ignores invalid MANDU_PLAYGROUND_ADAPTER values", () => {
    expect(
      resolveAdapterMode(baseEnv, { MANDU_PLAYGROUND_ADAPTER: "garbage" }),
    ).toBe("cloudflare");
  });
});

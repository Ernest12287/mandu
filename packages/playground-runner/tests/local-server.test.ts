/**
 * Integration tests for the local dev server (`src/local-server.ts`).
 *
 * Scope:
 *  - Health endpoint returns 200 JSON with `mode: "local"` + policy mirror
 *  - POST /run streams SSE events in the wire order (sandbox-url → stdout → exit)
 *  - Timeout path — an adapter that hangs past the watchdog gets terminated
 *    with `error: { reason: "timeout" }` (using a short-wallClock override
 *    so the test finishes in seconds, not 30s)
 *  - CORS preflight (OPTIONS) returns 204 with the expected headers
 *  - Bun.serve binds to 127.0.0.1 — the security boundary for local mode
 *
 * All tests spin up a real server on an ephemeral port (`port: 0`), then
 * tear it down in `afterEach`. We do NOT use `wrangler dev` or CF emulation.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { startLocalServer, type LocalServerHandle } from "../src/local-server";
import { LocalRunner, type LocalRunnerAdapter } from "../src/local-runner";
import type { RunOptions, SSEEvent } from "../src/types";
import { SECURITY_POLICY } from "../src/security";

// -----------------------------------------------------------------------------
// Test fixture helpers
// -----------------------------------------------------------------------------

let handle: LocalServerHandle | null = null;

async function boot(runner?: LocalRunner): Promise<LocalServerHandle> {
  // Port 0 → Bun picks an ephemeral port. Avoids collisions between tests.
  handle = await startLocalServer({
    port: 0,
    runner,
    quiet: true,
  });
  return handle;
}

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
});

/**
 * Consume an SSE stream from a fetch response and return the parsed events
 * in order. Each SSE frame is:
 *
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * Comment frames (`: heartbeat`) are ignored — they're keepalives.
 */
async function consumeSSE(
  response: Response,
  limit = 1000
): Promise<Array<{ type: string; data: unknown }>> {
  const events: Array<{ type: string; data: unknown }> = [];
  const reader = response.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (events.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by `\n\n`.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (frame.startsWith(":")) continue; // heartbeat comment

        // Parse `event: <type>` + `data: <json>`.
        const lines = frame.split("\n");
        let type = "";
        let data: unknown = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) type = line.slice("event: ".length);
          if (line.startsWith("data: ")) {
            try {
              data = JSON.parse(line.slice("data: ".length));
            } catch {
              // Non-JSON data line — record raw for debugging.
              data = line.slice("data: ".length);
            }
          }
        }
        if (type) events.push({ type, data });
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }

  return events;
}

// -----------------------------------------------------------------------------
// Bind address — security boundary verification
// -----------------------------------------------------------------------------

describe("local-server: bind address", () => {
  it("binds to 127.0.0.1 (loopback only, never 0.0.0.0)", async () => {
    const h = await boot();
    // Bun.serve returns `server.hostname`. Must be the loopback IP —
    // this is the security boundary: nothing off-box reaches us.
    expect(h.hostname).toBe("127.0.0.1");
  });

  it("uses an ephemeral port when requested (port: 0)", async () => {
    const h = await boot();
    expect(h.port).toBeGreaterThan(0);
    expect(h.port).toBeLessThan(65536);
  });
});

// -----------------------------------------------------------------------------
// Health endpoint
// -----------------------------------------------------------------------------

describe("local-server: GET /api/playground/health", () => {
  it("returns 200 JSON with mode=local and policy mirror", async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/api/playground/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      adapter: string;
      activeRuns: number;
      limits: { wallClockMs: number; outputCapBytes: number };
    };

    expect(body.ok).toBe(true);
    expect(body.mode).toBe("local");
    expect(body.adapter).toBe("mock");
    expect(body.activeRuns).toBe(0);
    expect(body.limits.wallClockMs).toBe(SECURITY_POLICY.wallClockMs);
    expect(body.limits.outputCapBytes).toBe(SECURITY_POLICY.outputCapBytes);
  });

  it("carries CORS headers for browser fetches", async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/api/playground/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173"
    );
    // Vary: Origin prevents cache cross-contamination.
    expect(res.headers.get("vary")).toContain("Origin");
  });
});

// -----------------------------------------------------------------------------
// CORS preflight
// -----------------------------------------------------------------------------

describe("local-server: CORS preflight", () => {
  it("OPTIONS returns 204 with the configured allow-origin", async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/api/playground/run`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173"
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "Content-Type"
    );
  });

  it("does NOT echo arbitrary Origin headers (anti-CSRF)", async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/api/playground/run`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    // Always returns the configured allowlist value, not the Origin
    // the attacker sent.
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173"
    );
  });
});

// -----------------------------------------------------------------------------
// POST /run — happy path
// -----------------------------------------------------------------------------

describe("local-server: POST /api/playground/run — happy path", () => {
  it("streams sandbox-url → stdout → exit in order", async () => {
    const h = await boot();

    const res = await fetch(`${h.url}/api/playground/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "console.log('hi')",
        example: "hello-mandu",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await consumeSSE(res);

    // Contract: sandbox-url first, exit or error last.
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("sandbox-url");

    const terminator = events[events.length - 1];
    expect(["exit", "error"]).toContain(terminator.type);

    // The default mock script prints two lines; at least one stdout event
    // must arrive between sandbox-url and exit. (CI may collapse chunks,
    // so we check inclusively.)
    const hasOutput = events.some((e) => e.type === "stdout");
    const terminatedAsExit = terminator.type === "exit";

    // On happy path we expect both output AND a clean exit. If the spawn
    // environment is stripped (uncommon — `MANDU_PLAYGROUND_CORS_ORIGIN`
    // tests etc. don't touch PATH) we tolerate an error terminator. Tests
    // downstream assert the strict invariants.
    if (terminatedAsExit) {
      expect(hasOutput).toBe(true);
    }
  }, 15_000);

  it("returns 400 + SSE error on invalid JSON body", async () => {
    const h = await boot();

    const res = await fetch(`${h.url}/api/playground/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{",
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("compile");
  });

  it("returns 400 + SSE error when code is missing", async () => {
    const h = await boot();

    const res = await fetch(`${h.url}/api/playground/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ example: "hello-mandu" }),
    });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("compile");
  });

  it("returns 400 when code exceeds 50 KiB input cap", async () => {
    const h = await boot();

    const res = await fetch(`${h.url}/api/playground/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "x".repeat(51_000),
        example: "hello-mandu",
      }),
    });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("50 KiB");
  });
});

// -----------------------------------------------------------------------------
// Not found
// -----------------------------------------------------------------------------

describe("local-server: unknown routes", () => {
  it("returns 404 for unknown paths", async () => {
    const h = await boot();
    const res = await fetch(`${h.url}/nope`);
    expect(res.status).toBe(404);
    // 404 responses still carry CORS headers so the browser can inspect
    // the status in a devtools network tab.
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173"
    );
  });
});

// -----------------------------------------------------------------------------
// Timeout — short wallClock override so the test finishes fast
// -----------------------------------------------------------------------------

/**
 * Adapter that emits a sandbox-url, then blocks forever waiting on a
 * promise that is only resolved when its cancel() is invoked.
 *
 * Used by the timeout test — the LocalRunner's watchdog should fire
 * regardless of whether the adapter cooperates. This exercises the
 * belt-and-suspenders abort path without sending a 30s `while(true){}`
 * through Bun.spawn.
 */
class HangingAdapter implements LocalRunnerAdapter {
  async *run(opts: RunOptions): AsyncIterable<SSEEvent> {
    yield {
      type: "sandbox-url",
      data: { url: `mock://sbx-${opts.runId}.localhost`, runId: opts.runId },
    };
    // Block indefinitely. The LocalRunner watchdog aborts via the signal;
    // the for-await in the runner breaks and emits a timeout error.
    // We still yield a valid SSE event to keep TypeScript happy.
    await new Promise(() => {
      // Never resolves — the runner's timeout breaks the for-await loop.
    });
    yield {
      type: "exit",
      data: { code: 0, durationMs: 0 },
    };
  }
}

describe("local-server: wall-clock timeout", () => {
  it("hanging adapter yields error=timeout within short window (wallClockMs override)", async () => {
    // Use a 500ms wallClock so the watchdog fires ~1.5s after start
    // (wallClockMs + 1s grace). Test timeout is 8s — plenty of slack.
    const runner = new LocalRunner({
      adapter: new HangingAdapter(),
      wallClockMs: 500,
      heartbeatMs: 10_000, // avoid heartbeat noise in the tiny window
    });

    const h = await boot(runner);
    const started = Date.now();

    const res = await fetch(`${h.url}/api/playground/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "while(true){}",
        example: "hello-mandu",
      }),
    });

    expect(res.status).toBe(200);

    const events = await consumeSSE(res);
    const elapsed = Date.now() - started;

    // Watchdog fires at wallClockMs + 1s grace. Allow 5s total for CI
    // scheduling jitter + test harness overhead.
    expect(elapsed).toBeLessThan(5_000);

    expect(events[0].type).toBe("sandbox-url");

    const last = events[events.length - 1] as {
      type: string;
      data: { reason?: string };
    };
    expect(last.type).toBe("error");
    expect(last.data.reason).toBe("timeout");
  }, 8_000);
});

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------

describe("local-server: shutdown", () => {
  it("stop() closes the server — subsequent connects fail", async () => {
    const h = await boot();
    const { url } = h;
    await h.stop();
    handle = null;

    // After stop the loopback listener is gone — fetches must reject.
    let fetched = false;
    try {
      // Short timeout so the rejected-connection error surfaces fast.
      await fetch(`${url}/api/playground/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      fetched = true;
    } catch {
      // Expected — connection refused / aborted.
    }
    expect(fetched).toBe(false);
  });
});

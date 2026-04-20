/**
 * Regression: issue #217
 *
 * `startServer()` prints a boot banner on stdout identifying the listen
 * address — "🥟 Mandu Dev Server listening at …" in dev mode or
 * "🥟 Mandu server listening at …" in production mode — plus a set of
 * auxiliary hint lines (additional addresses, HMR, CORS, streaming,
 * Kitchen dashboard, static-file hint).
 *
 * That banner is helpful for user-facing commands (`mandu dev`,
 * `mandu start`) but actively harmful for build-time orchestration.
 * `mandu build` spins up a transient HTTP listener on an ephemeral
 * port (`port: 0`) purely to render HTML for the prerender engine,
 * then tears it down seconds later. By the time a human (or an LLM
 * reading the build output) notices the URL and tries to curl it, the
 * process is gone and the URL is useless — yet the banner keeps
 * suggesting the server is reachable.
 *
 * The fix: `ServerOptions.silent` opts the banner out without
 * otherwise changing behavior. The HTTP listener still binds,
 * `ManduServer.server.port` still reports the chosen port, requests
 * still route — only the boot log is gated.
 *
 * These tests guard:
 *   1. Default (no `silent` option) still prints the dev banner.
 *   2. Default (no `silent` option) still prints the prod banner.
 *   3. `silent: true` suppresses the dev banner AND its auxiliary
 *      hint lines.
 *   4. `silent: true` suppresses the prod banner AND its auxiliary
 *      hint lines.
 *   5. `silent: true` does NOT break the HTTP listener — requests
 *      still get routed and the port is still exposed on the handle.
 *   6. `silent: false` behaves identically to omitting the flag.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  startServer,
  createServerRegistry,
  clearDefaultRegistry,
  type ManduServer,
} from "../../src/runtime/server";
import type { RoutesManifest } from "../../src/spec/schema";

const manifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "api/ping",
      pattern: "/api/ping",
      kind: "api",
      module: ".mandu/generated/server/api-ping.ts",
      methods: ["GET"],
    },
  ],
};

/**
 * Capture `console.log` calls for the duration of `fn`. Bun's
 * `console.log` has its own native writer that bypasses
 * `process.stdout.write`, so we patch `console.log` directly.
 */
async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const originalLog = console.log;
  let captured = "";
  console.log = (...args: unknown[]) => {
    captured +=
      args
        .map((a) => (typeof a === "string" ? a : String(a)))
        .join(" ") + "\n";
  };
  try {
    await fn();
  } finally {
    // Restore even on throw.
    console.log = originalLog;
  }
  return captured;
}

describe("startServer silent mode (#217)", () => {
  let server: ManduServer | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    clearDefaultRegistry();
  });

  it("default (no silent option) prints the prod banner", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    const output = await captureStdout(() => {
      server = startServer(manifest, { port: 0, registry });
    });

    expect(output).toContain("🥟 Mandu server listening at");
  });

  it("default (no silent option) prints the dev banner", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    const output = await captureStdout(() => {
      server = startServer(manifest, { port: 0, registry, isDev: true });
    });

    expect(output).toContain("🥟 Mandu Dev Server listening at");
    // Dev mode also emits the static-files hint.
    expect(output).toContain("Static files:");
  });

  it("silent: true suppresses the prod banner and all auxiliary hints", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    const output = await captureStdout(() => {
      server = startServer(manifest, {
        port: 0,
        registry,
        streaming: true, // would emit "🌊 Streaming SSR enabled" in non-silent prod
        silent: true,
      });
    });

    expect(output).not.toContain("🥟 Mandu server listening at");
    expect(output).not.toContain("🥟 Mandu Dev Server listening at");
    // Auxiliary hints tied to the banner must also be suppressed.
    expect(output).not.toContain("🌊 Streaming SSR enabled");
    expect(output).not.toContain("(also reachable at");
  });

  it("silent: true suppresses the dev banner and all auxiliary hints", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    const output = await captureStdout(() => {
      server = startServer(manifest, {
        port: 0,
        registry,
        isDev: true,
        cors: true, // would emit "🌐 CORS enabled" in non-silent dev
        silent: true,
      });
    });

    expect(output).not.toContain("🥟 Mandu Dev Server listening at");
    expect(output).not.toContain("🥟 Mandu server listening at");
    expect(output).not.toContain("Static files:");
    expect(output).not.toContain("🌐 CORS enabled");
  });

  it("silent: true still binds the HTTP listener and routes requests", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    // Run through captureStdout to also prove nothing leaks to stdout,
    // but keep the server running past the capture so we can fetch.
    const output = await captureStdout(() => {
      server = startServer(manifest, { port: 0, registry, silent: true });
    });

    expect(output).not.toContain("🥟");

    // Server handle is intact — port is exposed, routing works.
    const port = server!.server.port;
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("silent: false behaves identically to omitting the flag", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    const output = await captureStdout(() => {
      server = startServer(manifest, { port: 0, registry, silent: false });
    });

    expect(output).toContain("🥟 Mandu server listening at");
  });
});

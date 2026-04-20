/**
 * Regression: issues #223 + #225
 *
 * Two tightly-coupled fixes:
 *
 *   #223 — On Windows with Node 17+, `fetch("http://localhost:PORT")`
 *          resolves `localhost` to `::1` first. A server bound to the
 *          previous default `"0.0.0.0"` (IPv4-only) rejects that with
 *          `ECONNREFUSED ::1:PORT` while browsers + `curl` silently fall
 *          back to IPv4. Fix: default hostname is now `"::"` (IPv6
 *          wildcard, dual-stack) — Bun leaves `IPV6_V6ONLY` off so one
 *          socket accepts both families.
 *
 *   #225 — The startup banner unconditionally claimed `[::1]` was
 *          reachable regardless of the bind address. Lie when the
 *          socket was actually IPv4-only. Fix: `reachableHosts()`
 *          derives the URL list from the actual bind address, and
 *          `formatServerAddresses()` consumes it so the banner can
 *          only promise addresses that will actually answer.
 *
 * These tests guard both the pure derivation (`reachableHosts`) and the
 * end-to-end behavior (spin up a real server with `"::"` and verify both
 * IPv4 and IPv6 loopback connections succeed).
 */

import os from "os";
import { describe, it, expect, afterEach } from "bun:test";
import {
  startServer,
  createServerRegistry,
  clearDefaultRegistry,
  formatServerAddresses,
  reachableHosts,
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
 * Detect whether the test environment has a usable IPv6 loopback.
 * Some CI runners (stripped-down containers, IPv6-disabled kernels)
 * can't bind `::1` — skip those assertions cleanly instead of failing
 * the regression suite for environmental reasons.
 */
function hasIPv6Loopback(): boolean {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name] ?? [];
    for (const addr of list) {
      if (addr.family === "IPv6" && addr.internal && addr.address === "::1") {
        return true;
      }
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// reachableHosts() — pure derivation, no network
// ─────────────────────────────────────────────────────────────────────────

describe("reachableHosts() helper (#225)", () => {
  it("0.0.0.0 → [127.0.0.1] ONLY (no [::1])", () => {
    // Pre-#225 the banner reported `[::1]` for IPv4-wildcard binds.
    // That's a lie — IPv4 wildcard does NOT answer on the IPv6 loopback
    // socket. This is the exact regression we're guarding.
    expect(reachableHosts("0.0.0.0")).toEqual(["127.0.0.1"]);
  });

  it(":: → [127.0.0.1, [::1]] (dual-stack)", () => {
    expect(reachableHosts("::")).toEqual(["127.0.0.1", "[::1]"]);
  });

  it("all IPv6-wildcard aliases behave the same", () => {
    // Users may write any of these in config / env / CLI flags.
    expect(reachableHosts("::")).toEqual(["127.0.0.1", "[::1]"]);
    expect(reachableHosts("::0")).toEqual(["127.0.0.1", "[::1]"]);
    expect(reachableHosts("[::]")).toEqual(["127.0.0.1", "[::1]"]);
    expect(reachableHosts("0:0:0:0:0:0:0:0")).toEqual(["127.0.0.1", "[::1]"]);
  });

  it("undefined → default (dual-stack) reachable list", () => {
    // `undefined` hits the `::` default path — IPv6 wildcard.
    expect(reachableHosts(undefined)).toEqual(["127.0.0.1", "[::1]"]);
  });

  it("empty string → default (dual-stack) reachable list", () => {
    expect(reachableHosts("")).toEqual(["127.0.0.1", "[::1]"]);
  });

  it("specific IPv4 → only that address", () => {
    expect(reachableHosts("192.168.1.5")).toEqual(["192.168.1.5"]);
    expect(reachableHosts("127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("specific IPv6 → bracketed, only that address", () => {
    expect(reachableHosts("::1")).toEqual(["[::1]"]);
    expect(reachableHosts("fe80::1")).toEqual(["[fe80::1]"]);
  });

  it("DNS name → only that name", () => {
    expect(reachableHosts("example.com")).toEqual(["example.com"]);
  });

  it("trims whitespace before classifying", () => {
    // Env-var misconfigurations occasionally inject padding.
    expect(reachableHosts("  ::  ")).toEqual(["127.0.0.1", "[::1]"]);
    expect(reachableHosts(" 0.0.0.0 ")).toEqual(["127.0.0.1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// formatServerAddresses() — regression for banner lie (#225)
// ─────────────────────────────────────────────────────────────────────────

describe("formatServerAddresses() truthfulness (#225)", () => {
  it("0.0.0.0 bind reports IPv4 loopback ONLY (no [::1] lie)", () => {
    const { primary, additional } = formatServerAddresses("0.0.0.0", 3333);
    expect(primary).toBe("http://localhost:3333");
    expect(additional).toEqual(["http://127.0.0.1:3333"]);
    // Explicitly guard the old lie.
    expect(additional).not.toContain("http://[::1]:3333");
  });

  it(":: bind reports both loopbacks (actually reachable)", () => {
    const { primary, additional } = formatServerAddresses("::", 3333);
    expect(primary).toBe("http://localhost:3333");
    expect(additional).toEqual([
      "http://127.0.0.1:3333",
      "http://[::1]:3333",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// End-to-end: default dual-stack bind reaches both IPv4 and IPv6 (#223)
// ─────────────────────────────────────────────────────────────────────────

describe("startServer() dual-stack default (#223)", () => {
  let server: ManduServer | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    clearDefaultRegistry();
  });

  it("default bind answers on 127.0.0.1", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    expect(res.status).toBe(200);
  });

  it("default bind answers on [::1] (skipped when IPv6 unavailable)", async () => {
    if (!hasIPv6Loopback()) {
      // CI runner with no IPv6 loopback — the fix still applies but we
      // can't exercise the positive path here.
      return;
    }

    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://[::1]:${port}/api/ping`);
    expect(res.status).toBe(200);
  });

  it("default bind answers on localhost (the #223 exit criterion)", async () => {
    // The entire point of #223: `fetch("http://localhost:PORT")` from
    // Node must succeed regardless of whether the OS resolver prefers
    // IPv4 or IPv6 for `localhost`.
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/api/ping`);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Explicit "0.0.0.0" is still honored — no silent upgrade (#223)
// ─────────────────────────────────────────────────────────────────────────

describe("startServer() respects explicit hostname='0.0.0.0' (#223)", () => {
  let server: ManduServer | null = null;
  const originalPlatform = process.platform;
  const originalWarn = console.warn;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    clearDefaultRegistry();
    // Restore any platform spoof from the warning test.
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    console.warn = originalWarn;
  });

  it("binds IPv4-only when user pins '0.0.0.0' (no silent upgrade)", async () => {
    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, { port: 0, hostname: "0.0.0.0", registry });
    const port = server.server.port;

    // IPv4 succeeds.
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    expect(res.status).toBe(200);

    // We do NOT assert the IPv6 path fails here — that assertion is
    // platform-dependent (some OS kernels still accept `::1` for an
    // IPv4 wildcard under certain policies) and the goal of #225 is
    // that the *banner* doesn't claim it, not that we prove the
    // negative. The banner truthfulness is covered by the
    // formatServerAddresses tests above.
  });

  it("banner shows IPv4-only URLs when pinned to '0.0.0.0'", () => {
    // This is the user-visible surface for #225: if you bind IPv4 only,
    // the log must say so.
    const { additional } = formatServerAddresses("0.0.0.0", 9999);
    expect(additional).toEqual(["http://127.0.0.1:9999"]);
  });

  it("emits Windows warning when pinned to '0.0.0.0' on win32", () => {
    // Spoof platform — covers both directions so a macOS/Linux CI box
    // can still exercise the Windows branch. We also need `silent:
    // false` (the default) so the gate passes.
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;

    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, { port: 0, hostname: "0.0.0.0", registry });

    // Find the specific #223 discoverability warning.
    const matched = warnings.find((w) =>
      w.includes('hostname="0.0.0.0" binds IPv4 only'),
    );
    expect(matched).toBeDefined();
    expect(matched).toContain("may fail on Windows");
    expect(matched).toContain('hostname="::"');
  });

  it("does NOT emit the Windows warning on non-win32 platforms", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;

    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, { port: 0, hostname: "0.0.0.0", registry });

    const matched = warnings.find((w) =>
      w.includes('hostname="0.0.0.0" binds IPv4 only'),
    );
    expect(matched).toBeUndefined();
  });

  it("does NOT emit the Windows warning when silent: true", () => {
    // Internal callers (prerender orchestrator) pass silent: true.
    // They bind transient ephemeral sockets — we must not pollute
    // their stdout/stderr with the discoverability notice.
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;

    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, {
      port: 0,
      hostname: "0.0.0.0",
      registry,
      silent: true,
    });

    const matched = warnings.find((w) =>
      w.includes('hostname="0.0.0.0" binds IPv4 only'),
    );
    expect(matched).toBeUndefined();
  });

  it("does NOT emit the Windows warning when hostname defaults to '::'", () => {
    // The warning is for people who *explicitly* chose IPv4-only. The
    // default path (dual-stack) must be quiet.
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });

    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    }) as typeof console.warn;

    const registry = createServerRegistry();
    registry.registerApiHandler("api/ping", async () => Response.json({ ok: true }));

    server = startServer(manifest, { port: 0, registry });

    const matched = warnings.find((w) =>
      w.includes('hostname="0.0.0.0" binds IPv4 only'),
    );
    expect(matched).toBeUndefined();
  });
});

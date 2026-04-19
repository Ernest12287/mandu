/**
 * Phase 7.3 L-04 — X-Mandu-HDR echo dev gating.
 *
 * Lives in tests/server/ (no happy-dom) because happy-dom's fetch
 * implementation raises Parse Error on a freshly-booted Bun.serve
 * response; we need plain `fetch` here. The same L-04 assertion logic
 * would otherwise live alongside L-01/L-03 in tests/hdr/hdr-l-fixes.test.ts.
 *
 * Covers L-04 from the Phase 7.2 security audit
 * (docs/security/phase-7-2-audit.md §3 L-04):
 *   - in dev:  X-Mandu-HDR: 1 → response echoes X-Mandu-HDR: 1.
 *   - in prod: X-Mandu-HDR: 1 → response has NO X-Mandu-HDR header.
 *   - naked requests (no X-Mandu-HDR) never get the echo regardless of env.
 *
 * Reference: packages/core/src/runtime/server.ts:handlePageRoute
 *   isHDR = settings.isDev && req.headers.get("x-mandu-hdr") === "1"
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import React from "react";
import {
  startServer,
  createServerRegistry,
  clearDefaultRegistry,
  type ManduServer,
  type ServerRegistry,
} from "../../src/runtime/server";
import { ManduFilling } from "../../src/filling/filling";
import type { RoutesManifest } from "../../src/spec/schema";

function HelloPage({ loaderData }: { loaderData?: unknown }) {
  return React.createElement("div", { id: "hello" }, JSON.stringify(loaderData));
}

const hdrManifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "page/hello",
      pattern: "/hello",
      kind: "page",
      module: ".mandu/generated/server/page-hello.ts",
      componentModule: "app/hello/page.tsx",
    },
  ],
};

describe("Phase 7.3 L-04 — X-Mandu-HDR echo dev gating", () => {
  let server: ManduServer | null = null;
  let registry: ServerRegistry;

  beforeEach(() => {
    registry = createServerRegistry();
    const filling = new ManduFilling();
    // Constant loader so we can assert body + header in one shot.
    filling.loader(() => ({ count: 1, msg: "hello" }));
    registry.registerPageHandler("page/hello", async () => ({
      component: HelloPage,
      filling,
    }));
  });

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    clearDefaultRegistry();
  });

  it("[L-04.1] dev mode echoes X-Mandu-HDR: 1 on the _data=1 response when the request carries it", async () => {
    server = startServer(hdrManifest, {
      port: 0,
      registry,
      isDev: true,
    });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/hello?_data=1`, {
      headers: { "X-Mandu-HDR": "1" },
    });

    expect(res.status).toBe(200);
    // Echo header MUST be present in dev — advisory signal for observability.
    expect(res.headers.get("x-mandu-hdr")).toBe("1");
    const body = (await res.json()) as { loaderData: unknown };
    expect(body.loaderData).toEqual({ count: 1, msg: "hello" });
  });

  it("[L-04.2] prod mode (isDev=false) does NOT echo X-Mandu-HDR even when the request sends it", async () => {
    server = startServer(hdrManifest, {
      port: 0,
      registry,
      isDev: false,
    });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/hello?_data=1`, {
      headers: { "X-Mandu-HDR": "1" },
    });

    expect(res.status).toBe(200);
    // Header MUST be absent in prod — L-04 requirement.
    expect(res.headers.get("x-mandu-hdr")).toBeNull();
    // Normal _data=1 contract still holds — body unchanged.
    const body = (await res.json()) as { loaderData: unknown };
    expect(body.loaderData).toEqual({ count: 1, msg: "hello" });
  });

  it("[L-04.3] prod mode without X-Mandu-HDR request header — no echo (baseline)", async () => {
    server = startServer(hdrManifest, {
      port: 0,
      registry,
      isDev: false,
    });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/hello?_data=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mandu-hdr")).toBeNull();
  });

  it("[L-04.4] dev mode without X-Mandu-HDR request header — no echo (strict conditional)", async () => {
    server = startServer(hdrManifest, {
      port: 0,
      registry,
      isDev: true,
    });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/hello?_data=1`);
    expect(res.status).toBe(200);
    // The echo is CONDITIONAL on the request sending it first — no echo here.
    expect(res.headers.get("x-mandu-hdr")).toBeNull();
  });
});

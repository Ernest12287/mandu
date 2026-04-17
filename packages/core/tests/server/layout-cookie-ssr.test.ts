/**
 * DX-2: Layout slot cookie propagation.
 *
 * Regression guard — a `layout.slot.ts` that does `ctx.cookies.set(...)` must
 * ship those cookies on the outgoing Response (both non-streaming and
 * streaming SSR paths, and the SPA `_data` JSON path).
 *
 * Before DX-2 `loadLayoutData` returned only the loader data and silently
 * dropped its internal `ctx.cookies`, so layout-level auth plumbing (CSRF
 * token, session hints, etc.) never reached the browser.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
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

// ========== Test Components ==========

function TestPage({ loaderData }: { loaderData?: unknown }) {
  return React.createElement("div", null, `page:${JSON.stringify(loaderData ?? null)}`);
}

function TestLayout({ children }: { children: React.ReactNode }) {
  return React.createElement("section", { className: "layout" }, children);
}

// ========== Test Harness ==========

/**
 * Write a layout slot file to a temp dir and return its absolute path so the
 * test can wire it into `registry.layoutSlotPaths` directly (skipping the FS
 * probe). The file is a plain TS module whose `default` export is a
 * `ManduFilling`, matching what the runtime expects from a user's
 * `layout.slot.ts`.
 */
async function writeLayoutSlot(body: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-dx2-"));
  const slotPath = path.join(dir, `layout-${Date.now()}-${Math.random().toString(36).slice(2)}.slot.ts`);
  await fs.writeFile(slotPath, body, "utf8");
  return slotPath;
}

function makeSlotSource(setupBody: string): string {
  // Resolve the real source path (dev mode) so the temp module imports the
  // same ManduFilling implementation the runtime type-checks against.
  const coreSrc = path.resolve(import.meta.dir, "../../src").replace(/\\/g, "/");
  return `
import { ManduFilling } from "${coreSrc}/filling/filling";
const filling = new ManduFilling();
filling.loader(async (ctx) => {
  ${setupBody}
});
export default filling;
`;
}

interface Harness {
  server: ManduServer;
  port: number;
}

async function startWithLayoutSlot(
  registry: ServerRegistry,
  opts: {
    manifest: RoutesManifest;
    layoutModulePath: string;
    layoutSlotSource: string;
    layoutComponent?: (props: { children: React.ReactNode }) => React.ReactElement;
    streaming?: boolean;
    pageFilling?: ManduFilling;
  },
): Promise<Harness> {
  // 1. Register the layout component loader so `wrapWithLayouts` can find it.
  registry.registerLayoutLoader(opts.layoutModulePath, async () => ({
    default: opts.layoutComponent ?? TestLayout,
  } as any));

  // 2. Pre-populate the slot path cache with the tmpdir file — this is the
  //    same shape the FS probe would produce.
  const slotPath = await writeLayoutSlot(opts.layoutSlotSource);
  registry.layoutSlotPaths.set(opts.layoutModulePath, slotPath);

  // 3. Register the page handler (optionally with its own filling).
  registry.registerPageHandler("page/home", async () => ({
    component: TestPage,
    filling: opts.pageFilling,
  } as any));

  const server = startServer(opts.manifest, { port: 0, registry });
  const port = server.server.port;
  if (typeof port !== "number") {
    throw new Error("Server did not bind to a port");
  }
  return { server, port };
}

// ========== Tests ==========

const ROUTE: RoutesManifest["routes"][number] = {
  id: "page/home",
  pattern: "/",
  kind: "page",
  module: ".mandu/generated/server/page-home.ts",
  componentModule: "app/page.tsx",
  layoutChain: ["app/layout.tsx"],
} as RoutesManifest["routes"][number];

const STREAMING_ROUTE: RoutesManifest["routes"][number] = {
  ...ROUTE,
  streaming: true,
} as RoutesManifest["routes"][number];

describe("DX-2: layout.slot.ts cookie propagation", () => {
  let server: ManduServer | null = null;
  let registry: ServerRegistry;

  beforeEach(() => {
    registry = createServerRegistry();
  });

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
    clearDefaultRegistry();
  });

  it("1. layout slot sets a cookie → response includes that Set-Cookie header", async () => {
    const harness = await startWithLayoutSlot(registry, {
      manifest: { version: 1, routes: [ROUTE] },
      layoutModulePath: "app/layout.tsx",
      layoutSlotSource: makeSlotSource(`
        ctx.cookies.set("__csrf", "csrf-123", { httpOnly: true, path: "/" });
        return { user: null };
      `),
    });
    server = harness.server;

    const res = await fetch(`http://localhost:${harness.port}/`);
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    const csrf = setCookies.find(c => c.includes("__csrf="));
    expect(csrf).toBeDefined();
    expect(csrf).toContain("csrf-123");
    expect(csrf).toContain("HttpOnly");
  });

  it("2. layout sets cookie A, page loader sets cookie B → both ship", async () => {
    const pageFilling = new ManduFilling();
    pageFilling.loader((ctx) => {
      ctx.cookies.set("page_token", "page-xyz", { path: "/" });
      return { page: true };
    });

    const harness = await startWithLayoutSlot(registry, {
      manifest: { version: 1, routes: [ROUTE] },
      layoutModulePath: "app/layout.tsx",
      layoutSlotSource: makeSlotSource(`
        ctx.cookies.set("layout_token", "layout-abc", { path: "/" });
        return { layout: true };
      `),
      pageFilling,
    });
    server = harness.server;

    const res = await fetch(`http://localhost:${harness.port}/`);
    const setCookies = res.headers.getSetCookie();

    const layoutCookie = setCookies.find(c => c.includes("layout_token="));
    const pageCookie = setCookies.find(c => c.includes("page_token="));
    expect(layoutCookie).toBeDefined();
    expect(layoutCookie).toContain("layout-abc");
    expect(pageCookie).toBeDefined();
    expect(pageCookie).toContain("page-xyz");
  });

  it("3. layout and page both set cookie X with different values → page wins", async () => {
    const pageFilling = new ManduFilling();
    pageFilling.loader((ctx) => {
      ctx.cookies.set("conflict", "page-value", { path: "/" });
      return { page: true };
    });

    const harness = await startWithLayoutSlot(registry, {
      manifest: { version: 1, routes: [ROUTE] },
      layoutModulePath: "app/layout.tsx",
      layoutSlotSource: makeSlotSource(`
        ctx.cookies.set("conflict", "layout-value", { path: "/" });
        return { layout: true };
      `),
      pageFilling,
    });
    server = harness.server;

    const res = await fetch(`http://localhost:${harness.port}/`);
    const setCookies = res.headers.getSetCookie();

    // Both Set-Cookie headers ship — that's fine, HTTP allows duplicates.
    // What matters for "page wins" is the ORDER: page's Set-Cookie must come
    // AFTER the layout's, so browsers (which interpret later-same-name Set-Cookie
    // as overriding) end up storing the page's value.
    const entries = setCookies
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => c.includes("conflict="));
    expect(entries.length).toBe(2);

    const layoutEntry = entries.find(({ c }) => c.includes("layout-value"));
    const pageEntry = entries.find(({ c }) => c.includes("page-value"));
    expect(layoutEntry).toBeDefined();
    expect(pageEntry).toBeDefined();
    expect(pageEntry!.idx).toBeGreaterThan(layoutEntry!.idx);
  });

  it("4. layout sets cookie, page has no loader at all → layout cookie still ships", async () => {
    const harness = await startWithLayoutSlot(registry, {
      manifest: { version: 1, routes: [ROUTE] },
      layoutModulePath: "app/layout.tsx",
      layoutSlotSource: makeSlotSource(`
        ctx.cookies.set("layout_only", "alive", { path: "/" });
        return { layout: true };
      `),
      // no pageFilling → the page simply renders with no loader
    });
    server = harness.server;

    const res = await fetch(`http://localhost:${harness.port}/`);
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    const cookie = setCookies.find(c => c.includes("layout_only="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("alive");
  });

  it("5. streaming SSR: same guarantees — layout + page cookies both ship with page-wins order", async () => {
    const pageFilling = new ManduFilling();
    pageFilling.loader((ctx) => {
      ctx.cookies.set("conflict", "page-stream", { path: "/" });
      ctx.cookies.set("page_only", "ps", { path: "/" });
      return { streamed: true };
    });

    const harness = await startWithLayoutSlot(registry, {
      manifest: { version: 1, routes: [STREAMING_ROUTE] },
      layoutModulePath: "app/layout.tsx",
      layoutSlotSource: makeSlotSource(`
        ctx.cookies.set("conflict", "layout-stream", { path: "/" });
        ctx.cookies.set("layout_only", "lo", { path: "/" });
        return { layout: true };
      `),
      pageFilling,
      streaming: true,
    });
    server = harness.server;

    const res = await fetch(`http://localhost:${harness.port}/`);
    expect(res.status).toBe(200);
    // Streaming response sets a different Content-Type; the headers we care
    // about (Set-Cookie) are applied before the body starts flushing, because
    // `cookies.applyToResponse` clones headers onto a new Response wrapping
    // the same stream.

    const setCookies = res.headers.getSetCookie();

    // layout_only + page_only must both be present
    expect(setCookies.some(c => c.includes("layout_only=") && c.includes("lo"))).toBe(true);
    expect(setCookies.some(c => c.includes("page_only=") && c.includes("ps"))).toBe(true);

    // conflict: both headers present, page's must come AFTER layout's
    const conflictHeaders = setCookies
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => c.includes("conflict="));
    expect(conflictHeaders.length).toBe(2);
    const layoutIdx = conflictHeaders.find(({ c }) => c.includes("layout-stream"))!.idx;
    const pageIdx = conflictHeaders.find(({ c }) => c.includes("page-stream"))!.idx;
    expect(pageIdx).toBeGreaterThan(layoutIdx);

    // And the stream actually renders
    const html = await res.text();
    expect(html).toContain("page:");
  });

  it("6. layout slot with no cookie write behaves like before (no Set-Cookie from layout)", async () => {
    const harness = await startWithLayoutSlot(registry, {
      manifest: { version: 1, routes: [ROUTE] },
      layoutModulePath: "app/layout.tsx",
      layoutSlotSource: makeSlotSource(`
        return { layout: true };
      `),
    });
    server = harness.server;

    const res = await fetch(`http://localhost:${harness.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().length).toBe(0);
  });

  it("7. SPA _data request also carries layout cookies (client-side routing consistency)", async () => {
    // When a client-side navigation does fetch("/...?_data"), the layout
    // slot still runs on the server and any cookies it mints must reach
    // the browser, otherwise CSRF/session state silently desyncs on nav.
    const harness = await startWithLayoutSlot(registry, {
      manifest: { version: 1, routes: [ROUTE] },
      layoutModulePath: "app/layout.tsx",
      layoutSlotSource: makeSlotSource(`
        ctx.cookies.set("__csrf", "spa-csrf", { httpOnly: true, path: "/" });
        return { user: null };
      `),
    });
    server = harness.server;

    const res = await fetch(`http://localhost:${harness.port}/?_data`);
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some(c => c.includes("__csrf=") && c.includes("spa-csrf"))).toBe(true);
  });
});

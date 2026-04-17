/**
 * Integration tests for the `app/not-found.tsx` routing convention
 * (Phase 6.3). Mirrors redirect-loader.test.ts in shape: startServer with
 * an ephemeral port, exercise the real fetch path, assert status + body.
 *
 * Covers:
 *   1. Loader emits notFound() → `app/not-found.tsx` renders with 404.
 *   2. No `app/not-found.tsx` registered → built-in 404 JSON fallback.
 *   3. URL that doesn't match any route → same 404 path.
 *   4. `app/not-found.tsx` can expose its own loader data.
 *   5. Throwing inside `app/not-found.tsx` itself falls back cleanly (no loop).
 *   6. Cookies set before notFound() survive onto the 404 response.
 *   7. `throw notFound()` has the same effect as `return notFound()`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startServer,
  createServerRegistry,
  clearDefaultRegistry,
  type ManduServer,
  type ServerRegistry,
} from "../../src/runtime/server";
import { notFound } from "../../src/runtime/not-found";
import { ManduFilling } from "../../src/filling/filling";
import type { RoutesManifest } from "../../src/spec/schema";
import React from "react";

// ---------- Fixtures ----------

function ProductPage({ loaderData }: { loaderData?: unknown }) {
  return React.createElement(
    "div",
    { id: "product-rendered" },
    `product: ${JSON.stringify(loaderData)}`
  );
}

function NotFoundComponent({ loaderData }: { loaderData?: unknown }) {
  const data = (loaderData ?? {}) as { message?: string; extra?: string };
  return React.createElement(
    "main",
    { id: "mandu-not-found" },
    React.createElement("h1", null, "404 — Not Found"),
    React.createElement(
      "p",
      { id: "not-found-message" },
      data.message ?? "missing"
    ),
    data.extra
      ? React.createElement("p", { id: "not-found-extra" }, data.extra)
      : null
  );
}

const manifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "page/product",
      pattern: "/product/:id",
      kind: "page",
      module: ".mandu/generated/server/page-product.ts",
      componentModule: "app/product/[id]/page.tsx",
    },
  ],
};

// ---------- Suite ----------

describe("Phase 6.3: app/not-found.tsx routing convention", () => {
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

  it("loader returns notFound() → renders app/not-found.tsx with status 404", async () => {
    const filling = new ManduFilling();
    filling.loader(() => notFound({ message: "no such product" }));

    registry.registerPageHandler("page/product", async () => ({
      component: ProductPage,
      filling,
    }));
    registry.registerNotFoundHandler(async () => ({
      component: NotFoundComponent,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/product/missing`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("mandu-not-found");
    expect(body).toContain("no such product");
  });

  it("throw notFound() has the same effect as return notFound()", async () => {
    const filling = new ManduFilling();
    filling.loader(() => {
      throw notFound({ message: "thrown" });
    });

    registry.registerPageHandler("page/product", async () => ({
      component: ProductPage,
      filling,
    }));
    registry.registerNotFoundHandler(async () => ({
      component: NotFoundComponent,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/product/x`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("thrown");
  });

  it("no app/not-found.tsx registered → built-in 404 fallback (JSON)", async () => {
    const filling = new ManduFilling();
    filling.loader(() => notFound({ message: "gone" }));

    registry.registerPageHandler("page/product", async () => ({
      component: ProductPage,
      filling,
    }));
    // note: no registerNotFoundHandler

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/product/x`);
    expect(res.status).toBe(404);
    // built-in path is JSON error
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
  });

  it("unmatched URL → app/not-found.tsx still renders (router-level 404)", async () => {
    registry.registerNotFoundHandler(async () => ({
      component: NotFoundComponent,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/totally/made/up/url`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("mandu-not-found");
    expect(body).toContain("404 — Not Found");
  });

  it("unmatched URL with no not-found handler → built-in JSON 404", async () => {
    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/nope`);
    expect(res.status).toBe(404);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
  });

  it("app/not-found.tsx can set its own loader data", async () => {
    const pageFilling = new ManduFilling();
    pageFilling.loader(() => notFound({ message: "default" }));

    const nfFilling = new ManduFilling();
    nfFilling.loader(() => ({ message: "override-from-loader", extra: "hello" }));

    registry.registerPageHandler("page/product", async () => ({
      component: ProductPage,
      filling: pageFilling,
    }));
    registry.registerNotFoundHandler(async () => ({
      component: NotFoundComponent,
      filling: nfFilling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/product/x`);
    expect(res.status).toBe(404);
    const body = await res.text();
    // NotFoundComponent renders loaderData.message and loaderData.extra.
    expect(body).toContain("override-from-loader");
    expect(body).toContain("hello");
  });

  it("error thrown inside app/not-found.tsx render → built-in 404 (no infinite loop)", async () => {
    const pageFilling = new ManduFilling();
    pageFilling.loader(() => notFound({ message: "from page" }));

    function BrokenNotFound(): React.ReactElement {
      throw new Error("boom inside not-found.tsx");
    }

    registry.registerPageHandler("page/product", async () => ({
      component: ProductPage,
      filling: pageFilling,
    }));
    registry.registerNotFoundHandler(async () => ({
      component: BrokenNotFound,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/product/x`);
    // Must not hang, must not 500. Falls through to built-in 404.
    expect(res.status).toBe(404);
    // And the response must be served quickly (no infinite loop). Body
    // shape is the JSON fallback, not the broken component.
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
  });

  it("cookies set before notFound() survive onto the 404 response", async () => {
    const filling = new ManduFilling();
    filling.loader((ctx) => {
      // Set a cookie then declare the target missing.
      ctx.cookies.set("session", "abc123", { httpOnly: true, maxAge: 3600 });
      return notFound({ message: "post vanished" });
    });

    registry.registerPageHandler("page/product", async () => ({
      component: ProductPage,
      filling,
    }));
    registry.registerNotFoundHandler(async () => ({
      component: NotFoundComponent,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/product/x`);
    expect(res.status).toBe(404);

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThanOrEqual(1);
    const session = setCookies.find((c) => c.includes("session="));
    expect(session).toBeDefined();
    expect(session).toContain("abc123");
    expect(session).toContain("HttpOnly");
  });
});

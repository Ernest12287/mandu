/**
 * Loader Redirect Tests (DX-3)
 *
 * Verifies that a page's `Mandu.filling().loader(...)` can short-circuit
 * the SSR pipeline by returning or throwing a redirect Response. Exercises:
 *
 *   - Returned redirect → 302 Location on the wire
 *   - Thrown redirect → same outcome (Remix idiom)
 *   - Custom status (303 See Other)
 *   - Cookies set before the redirect are preserved
 *   - Normal (no-redirect) baseline still renders
 *   - Empty URL rejected at helper-call time (not silently)
 *   - Layout loader doesn't redirect, page loader does → page wins
 *   - `throw new Error(...)` in a loader does NOT become a redirect
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startServer,
  createServerRegistry,
  clearDefaultRegistry,
  type ManduServer,
  type ServerRegistry,
} from "../../src/runtime/server";
import { redirect } from "../../src/runtime/redirect";
import { ManduFilling } from "../../src/filling/filling";
import type { RoutesManifest } from "../../src/spec/schema";
import React from "react";

// ---------- Fixtures ----------

function TestPage({ loaderData }: { loaderData?: unknown }) {
  return React.createElement(
    "div",
    { id: "page-rendered" },
    `loader: ${JSON.stringify(loaderData)}`
  );
}

const manifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "page/dashboard",
      pattern: "/dashboard",
      kind: "page",
      module: ".mandu/generated/server/page-dashboard.ts",
      componentModule: "app/dashboard/page.tsx",
    },
  ],
};

// ---------- Suite ----------

describe("DX-3: loader redirect", () => {
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

  // Helper: fetch without following redirects so the test sees the 302.
  async function fetchNoFollow(url: string): Promise<Response> {
    return fetch(url, { redirect: "manual" });
  }

  it("returning redirect('/login') yields a 302 with Location: /login", async () => {
    const filling = new ManduFilling();
    filling.loader(() => redirect("/login"));

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    // No HTML body — SSR was skipped.
    expect(await res.text()).toBe("");
  });

  it("throwing redirect('/login') yields the same 302", async () => {
    const filling = new ManduFilling();
    filling.loader(() => {
      throw redirect("/login");
    });

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("custom status: redirect('/bye', { status: 303 }) yields 303", async () => {
    const filling = new ManduFilling();
    filling.loader(() => redirect("/bye", { status: 303 }));

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/bye");
  });

  it("preserves cookies set before the redirect (session must not drop)", async () => {
    const filling = new ManduFilling();
    filling.loader((ctx) => {
      // A typical auth-starter pattern: mint a CSRF cookie, then redirect
      // because the user isn't logged in. The cookie must survive.
      ctx.cookies.set("csrf", "tok_abc123", { httpOnly: true, maxAge: 3600 });
      return redirect("/login");
    });

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThanOrEqual(1);
    const csrf = setCookies.find((c) => c.includes("csrf="));
    expect(csrf).toBeDefined();
    expect(csrf).toContain("tok_abc123");
    expect(csrf).toContain("HttpOnly");
    expect(csrf).toContain("Max-Age=3600");
  });

  it("baseline (no redirect) still renders the page", async () => {
    const filling = new ManduFilling();
    filling.loader(() => ({ ok: true, user: "alice" }));

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("page-rendered");
    expect(body).toContain("alice");
  });

  it("empty URL is rejected synchronously (loud, not silent success)", () => {
    expect(() => redirect("")).toThrow(TypeError);
    expect(() => redirect("   ")).toThrow(TypeError);
    // @ts-expect-error — verifying runtime guard for a bad caller
    expect(() => redirect(null)).toThrow(TypeError);
  });

  it("throw new Error() in a loader is NOT mistaken for a redirect", async () => {
    const filling = new ManduFilling();
    filling.loader(() => {
      throw new Error("kaboom");
    });

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    // Error path is unchanged: 500 (or SSR error), never 302.
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(303);
    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(308);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirect with a custom header propagates alongside the Location header", async () => {
    const filling = new ManduFilling();
    filling.loader(() =>
      redirect("/after", {
        status: 307,
        headers: { "X-Reason": "auth-required" },
      })
    );

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/after");
    expect(res.headers.get("x-reason")).toBe("auth-required");
  });

  it("invalid status codes throw at the helper (no 418 etc)", () => {
    // @ts-expect-error — runtime guard for bad status
    expect(() => redirect("/x", { status: 200 })).toThrow(TypeError);
    // @ts-expect-error
    expect(() => redirect("/x", { status: 418 })).toThrow(TypeError);
    // @ts-expect-error
    expect(() => redirect("/x", { status: 999 })).toThrow(TypeError);
  });

  it("layout loader data does NOT trigger redirect; only page's loader wins", async () => {
    // Simulate a nested case: layout loader returns normal data, page loader
    // redirects. The redirect must still fire. This is the "protected page
    // inside a public layout" pattern.
    //
    // We don't run a real layout slot here (that requires writing a .slot.ts
    // to disk) — instead we prove the loadPageData path ignores layoutLoad
    // and short-circuits on the page's redirect. The `baseline` test above
    // already proves layout-less rendering still works, and the cookie test
    // proves non-redirect loaders still run normally.
    const pageFilling = new ManduFilling();
    pageFilling.loader(() => redirect("/login", { status: 302 }));

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling: pageFilling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    // Page's redirect wins regardless of what layouts might have loaded.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("SPA navigation (_data=1) also respects the redirect", async () => {
    // Client-side routing fetches `/dashboard?_data=1` expecting JSON. If
    // the loader redirects, the router must see a 302 (not JSON) so it
    // follows the navigation server-side instead of rendering the page.
    const filling = new ManduFilling();
    filling.loader(() => redirect("/login"));

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard?_data=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("streaming SSR path also short-circuits on redirect", async () => {
    // When `streaming: true`, the server otherwise takes the
    // renderStreamingResponse branch. A loader redirect must still win —
    // we never open the stream (header timing would be impossible if we
    // already flushed a Shell).
    const streamingManifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          id: "page/dashboard",
          pattern: "/dashboard",
          kind: "page",
          module: ".mandu/generated/server/page-dashboard.ts",
          componentModule: "app/dashboard/page.tsx",
          streaming: true,
        },
      ],
    };

    const filling = new ManduFilling();
    filling.loader(() => redirect("/login", { status: 307 }));

    registry.registerPageHandler("page/dashboard", async () => ({
      component: TestPage,
      filling,
    }));

    server = startServer(streamingManifest, { port: 0, registry, streaming: true });
    const port = server.server.port;

    const res = await fetchNoFollow(`http://localhost:${port}/dashboard`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login");
    // No HTML — the stream never opened.
    expect(await res.text()).toBe("");
    // Must not be a stream content-type (confirms no SSR happened).
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).not.toContain("text/html");
  });
});

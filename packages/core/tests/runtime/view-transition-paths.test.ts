/**
 * Issue #207 — `@view-transition` regression guard.
 *
 * The style tag `<style>@view-transition{navigation:auto}</style>` MUST
 * appear in every HTML SSR response path, including the ones that the
 * original Issue #192 suite (smooth-navigation.test.ts) skipped:
 *
 *   1. Streaming SSR shell (`renderToStream` / `renderStreamingResponse`)
 *   2. Build-time prerender output (`prerenderRoutes` → fetchHandler)
 *   3. Server-rendered 404 (`renderSSR({ title: "Not Found" })`)
 *   4. Error-page surface (`renderSSR` fallback after page throws)
 *
 * And `transitions: false` MUST reliably suppress the tag across every
 * path (non-streaming + streaming). No change to existing default-`true`
 * behavior on any path.
 *
 * This complements `smooth-navigation.test.ts` which unit-tests only
 * the non-streaming `renderToHTML` entry point.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import React from "react";
import path from "path";
import fs from "fs/promises";
import { tmpdir } from "os";
import { renderToStream, renderStreamingResponse } from "../../src/runtime/streaming-ssr";
import { renderSSR, renderToHTML } from "../../src/runtime/ssr";
import { prerenderRoutes } from "../../src/bundler/prerender";
import type { RoutesManifest } from "../../src/spec/schema";

const VT = "<style>@view-transition{navigation:auto}</style>";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

function SimplePage({ msg = "hi" }: { msg?: string }) {
  return React.createElement("p", null, msg);
}

// ---------------------------------------------------------------------------
// 1. Streaming SSR shell — default on
// ---------------------------------------------------------------------------

describe("Issue #207 — streaming SSR injection", () => {
  it("renderToStream emits `<style>@view-transition…</style>` in the shell by default", async () => {
    const stream = await renderToStream(
      React.createElement(SimplePage, { msg: "streamed" }),
      { title: "Stream Default" },
    );
    const html = await drainStream(stream);
    expect(html).toContain("@view-transition");
    expect(html).toContain(VT);
    // Byte-identical to the non-streaming path.
    const sync = renderToHTML(React.createElement(SimplePage, { msg: "sync" }));
    const streamSample = html.match(/<style>@view-transition[^<]*<\/style>/)?.[0];
    const syncSample = sync.match(/<style>@view-transition[^<]*<\/style>/)?.[0];
    expect(streamSample).toBe(syncSample);
  });

  it("places the view-transition style inside the <head>, before `</head>`", async () => {
    const stream = await renderToStream(
      React.createElement(SimplePage),
      { title: "Stream Head Ordering" },
    );
    const html = await drainStream(stream);
    const headBlock = html.split("<head>")[1]?.split("</head>")[0] ?? "";
    expect(headBlock).toContain("@view-transition");
  });

  it("renderStreamingResponse Response body includes the style tag", async () => {
    const response = await renderStreamingResponse(
      React.createElement(SimplePage),
      { title: "Stream Response" },
    );
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain(VT);
  });
});

// ---------------------------------------------------------------------------
// 2. Streaming SSR — explicit opt-out
// ---------------------------------------------------------------------------

describe("Issue #207 — streaming SSR opt-out", () => {
  it("transitions: false suppresses the tag on the streaming path", async () => {
    const stream = await renderToStream(
      React.createElement(SimplePage),
      { title: "Stream Off", transitions: false },
    );
    const html = await drainStream(stream);
    expect(html).not.toContain("@view-transition");
  });

  it("transitions: true (explicit) behaves the same as the default", async () => {
    const explicitStream = await renderToStream(
      React.createElement(SimplePage),
      { title: "Stream Explicit", transitions: true },
    );
    const explicit = await drainStream(explicitStream);
    const defaultStream = await renderToStream(
      React.createElement(SimplePage),
      { title: "Stream Explicit" },
    );
    const def = await drainStream(defaultStream);
    expect(explicit).toContain(VT);
    expect(def).toContain(VT);
  });

  it("prefetch: false alone still leaves the view-transition tag intact", async () => {
    const stream = await renderToStream(
      React.createElement(SimplePage),
      { title: "Stream Prefetch Off", prefetch: false },
    );
    const html = await drainStream(stream);
    expect(html).toContain(VT);
  });
});

// ---------------------------------------------------------------------------
// 3. 404 + error-page surfaces (renderSSR direct — same code path the
//    server uses for `renderNotFoundPage` / errorModule fallback)
// ---------------------------------------------------------------------------

describe("Issue #207 — 404 + error page surfaces", () => {
  it("renderSSR(title: 'Not Found') response body contains the tag", async () => {
    const response = renderSSR(React.createElement(SimplePage, { msg: "nf" }), {
      title: "Not Found",
    });
    const body = await response.text();
    expect(body).toContain(VT);
    expect(body).toContain("<title>Not Found</title>");
  });

  it("renderSSR(title: 'Mandu App — Error') response body contains the tag", async () => {
    const response = renderSSR(React.createElement(SimplePage, { msg: "e" }), {
      title: "Mandu App — Error",
    });
    const body = await response.text();
    expect(body).toContain(VT);
  });

  it("renderSSR honors transitions: false on the 404 surface", async () => {
    const response = renderSSR(React.createElement(SimplePage, { msg: "nf" }), {
      title: "Not Found",
      transitions: false,
    });
    const body = await response.text();
    expect(body).not.toContain("@view-transition");
  });
});

// ---------------------------------------------------------------------------
// 4. Build-time prerender output
// ---------------------------------------------------------------------------

describe("Issue #207 — prerender output", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(tmpdir(), "mandu-207-prerender-"));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it("prerendered static HTML contains the view-transition tag", async () => {
    // Minimal manifest — one static page route. The fetch handler below
    // simulates the real dispatcher by returning an HTML response from
    // renderSSR (which is what `handleRequest` does after `renderPageSSR`
    // succeeds).
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          kind: "page",
          id: "prerender-home",
          pattern: "/",
          module: "app/page.tsx",
        } as unknown as RoutesManifest["routes"][number],
      ],
    } as unknown as RoutesManifest;

    const fetchHandler = async (_req: Request): Promise<Response> => {
      return renderSSR(
        React.createElement(SimplePage, { msg: "prerendered" }),
        { title: "Prerender Home" },
      );
    };

    const outDir = path.join(workDir, "static");
    const result = await prerenderRoutes(manifest, fetchHandler, {
      rootDir: workDir,
      outDir,
    });

    expect(result.errors).toEqual([]);
    expect(result.generated).toBeGreaterThan(0);

    const indexHtml = await fs.readFile(path.join(outDir, "index.html"), "utf-8");
    expect(indexHtml).toContain(VT);
    expect(indexHtml).toContain("prerendered");
  });

  it("prerender honors transitions: false end-to-end", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          kind: "page",
          id: "prerender-off",
          pattern: "/off",
          module: "app/off/page.tsx",
        } as unknown as RoutesManifest["routes"][number],
      ],
    } as unknown as RoutesManifest;

    const fetchHandler = async (_req: Request): Promise<Response> => {
      return renderSSR(
        React.createElement(SimplePage, { msg: "no-vt" }),
        { title: "Prerender Off", transitions: false },
      );
    };

    const outDir = path.join(workDir, "static-off");
    const result = await prerenderRoutes(manifest, fetchHandler, {
      rootDir: workDir,
      outDir,
    });
    expect(result.errors).toEqual([]);

    const html = await fs.readFile(
      path.join(outDir, "off", "index.html"),
      "utf-8",
    );
    expect(html).not.toContain("@view-transition");
    expect(html).toContain("no-vt");
  });
});

// ---------------------------------------------------------------------------
// 5. Byte-stability across paths
// ---------------------------------------------------------------------------

describe("Issue #207 — byte-stability across paths", () => {
  it("streaming + non-streaming emit the same literal style tag", async () => {
    const sync = renderToHTML(React.createElement(SimplePage));
    const stream = await drainStream(
      await renderToStream(React.createElement(SimplePage)),
    );
    const marker = "<style>@view-transition{navigation:auto}</style>";
    expect(sync).toContain(marker);
    expect(stream).toContain(marker);
  });
});

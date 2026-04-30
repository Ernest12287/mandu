/**
 * Issue #254 — `mandu build --static` emits `dist/404.html` when the
 * project declares `app/not-found.tsx`. Hosting platforms (Vercel,
 * Netlify, Cloudflare Pages) auto-serve that file for unmatched URLs.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { prerenderRoutes } from "../../src/bundler/prerender";
import type { RoutesManifest } from "../../src/spec/schema";

async function setupRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-404-"));
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  return root;
}

describe("Issue #254 — 404.html emission", () => {
  let root: string;
  beforeEach(async () => {
    root = await setupRoot();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("emits dist/404.html when app/not-found.tsx exists and the probe gets 404", async () => {
    await fs.writeFile(
      path.join(root, "app/not-found.tsx"),
      "export default function NotFound() { return null; }\n",
    );
    const manifest: RoutesManifest = { version: 1, routes: [] };
    const fetchHandler = async (req: Request): Promise<Response> => {
      // Mirror the runtime: every probe path is a 404 because nothing matches.
      return new Response(`<html><body>not-found rendered for ${new URL(req.url).pathname}</body></html>`, {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    };
    const outDir = path.join(root, ".mandu/prerendered");
    const result = await prerenderRoutes(manifest, fetchHandler, { rootDir: root, outDir });
    expect(result.errors).toEqual([]);
    const fourOhFour = await fs.readFile(path.join(outDir, "404.html"), "utf8");
    expect(fourOhFour).toContain("not-found rendered");
  });

  it("does NOT emit 404.html when app/not-found.tsx is absent", async () => {
    const manifest: RoutesManifest = { version: 1, routes: [] };
    const fetchHandler = async (): Promise<Response> =>
      new Response("nope", { status: 404 });
    const outDir = path.join(root, ".mandu/prerendered");
    await prerenderRoutes(manifest, fetchHandler, { rootDir: root, outDir });
    const exists = await fs
      .stat(path.join(outDir, "404.html"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("warns and does NOT emit 404.html when a catch-all route swallows the probe", async () => {
    await fs.writeFile(
      path.join(root, "app/not-found.tsx"),
      "export default function NotFound() { return null; }\n",
    );
    const manifest: RoutesManifest = { version: 1, routes: [] };
    const fetchHandler = async (): Promise<Response> =>
      // Catch-all returned 200 with a real-page body — we must NOT
      // write that as 404.html.
      new Response("<html>real catch-all page</html>", { status: 200 });
    const outDir = path.join(root, ".mandu/prerendered");
    const result = await prerenderRoutes(manifest, fetchHandler, { rootDir: root, outDir });
    expect(result.errors.some((e) => e.includes("[404.html]"))).toBe(true);
    const exists = await fs
      .stat(path.join(outDir, "404.html"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("recognises non-tsx variants of not-found", async () => {
    await fs.writeFile(
      path.join(root, "app/not-found.js"),
      "export default function NotFound() { return null; }\n",
    );
    const manifest: RoutesManifest = { version: 1, routes: [] };
    const fetchHandler = async (): Promise<Response> =>
      new Response("<html>404 from not-found.js</html>", { status: 404 });
    const outDir = path.join(root, ".mandu/prerendered");
    await prerenderRoutes(manifest, fetchHandler, { rootDir: root, outDir });
    const fourOhFour = await fs.readFile(path.join(outDir, "404.html"), "utf8");
    expect(fourOhFour).toContain("not-found.js");
  });
});

/**
 * Metadata Routes — End-to-End Integration
 *
 * Exercises the full pipeline: fs-scanner → manifest → dispatcher.
 * Simulates what the dev/start server does at startup by:
 *   1. Scanning a tmp project for metadata files
 *   2. Importing each user module via `await import()`
 *   3. Dispatching via `handleMetadataRoute` and asserting the body
 *
 * This is the closest we can get to the `curl` check without
 * actually spinning up `Bun.serve`, which adds flaky port + lifecycle
 * concerns without catching additional bugs.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { scanRoutes } from "../../src/router";
import { handleMetadataRoute } from "../../src/routes";
import { fsRouteToRouteSpec } from "../../src/router/fs-routes";
import { assertMetadataRoute } from "../../src/spec/schema";

const TEST_DIR = join(import.meta.dir, "__metadata_integration__");

describe("metadata routes — integration", () => {
  beforeAll(async () => {
    await mkdir(join(TEST_DIR, "app"), { recursive: true });

    await writeFile(
      join(TEST_DIR, "app", "page.tsx"),
      "export default function Home() { return null; }"
    );
    await writeFile(
      join(TEST_DIR, "app", "sitemap.ts"),
      `export default async function sitemap() {
  return [
    { url: "https://example.com/", lastModified: new Date("2024-01-01T00:00:00Z"), changeFrequency: "weekly", priority: 1 },
    { url: "https://example.com/docs", lastModified: new Date("2024-01-15T00:00:00Z") },
  ];
}
`
    );
    await writeFile(
      join(TEST_DIR, "app", "robots.ts"),
      `export default function robots() {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: "/admin" }],
    sitemap: "https://example.com/sitemap.xml",
  };
}
`
    );
    await writeFile(
      join(TEST_DIR, "app", "llms.txt.ts"),
      `export default async function llmsTxt() {
  return "# My site\\n\\nDocumentation index for LLMs.\\n";
}
`
    );
    await writeFile(
      join(TEST_DIR, "app", "manifest.ts"),
      `export default function manifest() {
  return {
    name: "Mandu Metadata Test",
    short_name: "Mandu",
    icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
  };
}
`
    );
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  async function dispatchByPattern(pattern: string): Promise<Response> {
    const scan = await scanRoutes(TEST_DIR);
    const fsRoute = scan.routes.find((r) => r.pattern === pattern);
    if (!fsRoute) throw new Error(`No route for ${pattern}`);

    // Go through fsRouteToRouteSpec so we get the validated union
    // type — this mirrors what `generateManifest` does in production.
    const route = fsRouteToRouteSpec(fsRoute);
    assertMetadataRoute(route);

    // Import the user module the same way `handlers.ts` does.
    const absModulePath = join(TEST_DIR, route.module);
    const userModule = await import(absModulePath);

    return handleMetadataRoute({
      kind: route.metadataKind,
      userExport: userModule,
      sourceFile: route.module,
    });
  }

  it("GET /sitemap.xml → valid XML starting with <?xml", async () => {
    const res = await dispatchByPattern("/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const body = await res.text();
    expect(body.slice(0, 100)).toContain("<?xml version");
    expect(body).toContain("<loc>https://example.com/</loc>");
    expect(body).toContain("<loc>https://example.com/docs</loc>");
  });

  it("GET /robots.txt → valid robots.txt body", async () => {
    const res = await dispatchByPattern("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body.slice(0, 100)).toContain("User-agent: *");
    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /admin");
    expect(body).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("GET /llms.txt → plain-text passthrough", async () => {
    const res = await dispatchByPattern("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body.slice(0, 50)).toContain("# My site");
  });

  it("GET /manifest.webmanifest → valid JSON", async () => {
    const res = await dispatchByPattern("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/manifest+json; charset=utf-8"
    );
    const body = await res.text();
    const parsed = JSON.parse(body);
    expect(parsed.name).toBe("Mandu Metadata Test");
    expect(parsed.short_name).toBe("Mandu");
    expect(parsed.icons).toHaveLength(1);
  });

  it("applies the default cache header across every kind", async () => {
    for (const pattern of [
      "/sitemap.xml",
      "/robots.txt",
      "/llms.txt",
      "/manifest.webmanifest",
    ]) {
      const res = await dispatchByPattern(pattern);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    }
  });
});

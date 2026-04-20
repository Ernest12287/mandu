/**
 * FS Scanner — Metadata Route Detection
 *
 * Verifies Issue #206 auto-discovery:
 *   • Detects the four metadata files at `app/` root
 *   • Does NOT confuse them with regular pages/api routes
 *   • Refuses to detect nested (`app/foo/sitemap.ts`) metadata files
 *   • Writes correct RouteSpec.kind/contentType into the manifest
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { scanRoutes, generateManifest } from "../../src/router";
import {
  assertMetadataRoute,
  type MetadataRouteSpec,
} from "../../src/spec/schema";

const TEST_DIR = join(import.meta.dir, "__fs_scanner_metadata__");

describe("fs-scanner — metadata routes", () => {
  beforeAll(async () => {
    await mkdir(join(TEST_DIR, "app"), { recursive: true });
    await mkdir(join(TEST_DIR, "app", "blog"), { recursive: true });

    // Normal page alongside metadata — to make sure we don't collide.
    await writeFile(
      join(TEST_DIR, "app", "page.tsx"),
      "export default function Home() { return null; }"
    );
    await writeFile(
      join(TEST_DIR, "app", "blog", "page.tsx"),
      "export default function Blog() { return null; }"
    );

    // Four metadata files at the root.
    await writeFile(
      join(TEST_DIR, "app", "sitemap.ts"),
      "export default async function sitemap() { return []; }"
    );
    await writeFile(
      join(TEST_DIR, "app", "robots.ts"),
      "export default function robots() { return { rules: [{ userAgent: '*', allow: '/' }] }; }"
    );
    await writeFile(
      join(TEST_DIR, "app", "llms.txt.ts"),
      "export default async function llmsTxt() { return '# site'; }"
    );
    await writeFile(
      join(TEST_DIR, "app", "manifest.ts"),
      "export default function manifest() { return { name: 'App', short_name: 'A', icons: [{ src: '/i.png' }] }; }"
    );
  });

  afterAll(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("detects all four metadata files at app/ root", async () => {
    const result = await scanRoutes(TEST_DIR);
    const metaFiles = result.files.filter((f) => f.type === "metadata");
    expect(metaFiles).toHaveLength(4);

    const kinds = new Set(metaFiles.map((f) => f.metadataKind));
    expect(kinds.has("sitemap")).toBe(true);
    expect(kinds.has("robots")).toBe(true);
    expect(kinds.has("llms-txt")).toBe(true);
    expect(kinds.has("manifest")).toBe(true);
  });

  it("generates routes with the correct patterns", async () => {
    const result = await scanRoutes(TEST_DIR);

    const sitemap = result.routes.find((r) => r.pattern === "/sitemap.xml");
    const robots = result.routes.find((r) => r.pattern === "/robots.txt");
    const llms = result.routes.find((r) => r.pattern === "/llms.txt");
    const manifest = result.routes.find((r) => r.pattern === "/manifest.webmanifest");

    expect(sitemap).toBeDefined();
    expect(robots).toBeDefined();
    expect(llms).toBeDefined();
    expect(manifest).toBeDefined();

    expect(sitemap?.kind).toBe("metadata");
    expect(robots?.kind).toBe("metadata");
    expect(llms?.kind).toBe("metadata");
    expect(manifest?.kind).toBe("metadata");

    expect(sitemap?.metadataKind).toBe("sitemap");
    expect(robots?.metadataKind).toBe("robots");
    expect(llms?.metadataKind).toBe("llms-txt");
    expect(manifest?.metadataKind).toBe("manifest");
  });

  it("generates stable ids (`metadata-<kind>`)", async () => {
    const result = await scanRoutes(TEST_DIR);
    const ids = new Set(result.routes.map((r) => r.id));
    expect(ids.has("metadata-sitemap")).toBe(true);
    expect(ids.has("metadata-robots")).toBe(true);
    expect(ids.has("metadata-llms-txt")).toBe(true);
    expect(ids.has("metadata-manifest")).toBe(true);
  });

  it("does not double-register — metadata files coexist with page.tsx", async () => {
    const result = await scanRoutes(TEST_DIR);
    // The home page and the blog page must still be present.
    expect(result.routes.some((r) => r.pattern === "/" && r.kind === "page")).toBe(true);
    expect(result.routes.some((r) => r.pattern === "/blog" && r.kind === "page")).toBe(
      true
    );
    // Pattern uniqueness — no conflicts.
    const patterns = result.routes.map((r) => r.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("writes metadataKind + contentType into the generated manifest", async () => {
    const { manifest } = await generateManifest(TEST_DIR, {});
    const sitemap = manifest.routes.find((r) => r.pattern === "/sitemap.xml");
    expect(sitemap).toBeDefined();
    assertMetadataRoute(sitemap!);
    const mRoute: MetadataRouteSpec = sitemap!;
    expect(mRoute.metadataKind).toBe("sitemap");
    expect(mRoute.contentType).toContain("application/xml");

    const manifestRoute = manifest.routes.find(
      (r) => r.pattern === "/manifest.webmanifest"
    );
    expect(manifestRoute).toBeDefined();
    assertMetadataRoute(manifestRoute!);
    expect(manifestRoute!.contentType).toContain("application/manifest+json");
  });

  it("counts metadata routes in scan stats", async () => {
    const result = await scanRoutes(TEST_DIR);
    expect(result.stats.metadataCount).toBe(4);
  });
});

describe("fs-scanner — nested metadata files are rejected", () => {
  const nestedDir = join(import.meta.dir, "__fs_scanner_metadata_nested__");

  beforeAll(async () => {
    await mkdir(join(nestedDir, "app", "admin"), { recursive: true });
    // An `app/admin/sitemap.ts` is ambiguous — must be at app/ root.
    await writeFile(
      join(nestedDir, "app", "admin", "sitemap.ts"),
      "export default function sitemap() { return []; }"
    );
  });

  afterAll(async () => {
    await rm(nestedDir, { recursive: true, force: true });
  });

  it("reports an invalid_segment error", async () => {
    const result = await scanRoutes(nestedDir);
    const hasErr = result.errors.some(
      (e) => e.type === "invalid_segment" && e.message.includes("sitemap")
    );
    expect(hasErr).toBe(true);
    // No metadata route should have been registered.
    expect(result.routes.filter((r) => r.kind === "metadata")).toHaveLength(0);
  });
});

describe("fs-scanner — no metadata files is fine", () => {
  const plainDir = join(import.meta.dir, "__fs_scanner_metadata_absent__");

  beforeAll(async () => {
    await mkdir(join(plainDir, "app"), { recursive: true });
    await writeFile(
      join(plainDir, "app", "page.tsx"),
      "export default function Home() { return null; }"
    );
  });

  afterAll(async () => {
    await rm(plainDir, { recursive: true, force: true });
  });

  it("scans cleanly with zero metadata routes", async () => {
    const result = await scanRoutes(plainDir);
    expect(result.stats.metadataCount).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.routes.some((r) => r.kind === "metadata")).toBe(false);
  });
});

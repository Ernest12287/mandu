/**
 * Metadata Routes — Runtime Tests
 *
 * Covers the four file-convention routes from Issue #206:
 *   • sitemap.ts → /sitemap.xml
 *   • robots.ts → /robots.txt
 *   • llms.txt.ts → /llms.txt
 *   • manifest.ts → /manifest.webmanifest
 *
 * Tests are grouped by (a) pure renderers — deterministic string
 * output, exhaustive format coverage — and (b) the `handleMetadataRoute`
 * dispatcher which wires validation + Response headers + error paths.
 */
import { describe, it, expect } from "bun:test";
import {
  renderSitemap,
  renderRobots,
  renderManifest,
  renderLlmsTxt,
  renderValidated,
  handleMetadataRoute,
  getMetadataRouteMeta,
  MetadataRouteValidationError,
  METADATA_ROUTES,
  type Sitemap,
  type Robots,
  type WebAppManifest,
} from "../../src/routes";

// ═══════════════════════════════════════════════════════════════════════════
// Happy paths — pure renderers
// ═══════════════════════════════════════════════════════════════════════════

describe("renderSitemap", () => {
  it("emits valid XML with default namespaces only", () => {
    const sitemap: Sitemap = [
      { url: "https://example.com/" },
      { url: "https://example.com/about" },
    ];
    const xml = renderSitemap(sitemap);
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    // Image / xhtml namespaces NOT included when unused.
    expect(xml).not.toContain("xmlns:image");
    expect(xml).not.toContain("xmlns:xhtml");
    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toEndWith("</urlset>");
  });

  it("serializes lastModified (Date) as ISO string", () => {
    const date = new Date("2024-03-15T10:20:30Z");
    const xml = renderSitemap([{ url: "https://example.com/", lastModified: date }]);
    expect(xml).toContain(`<lastmod>${date.toISOString()}</lastmod>`);
  });

  it("emits changefreq and priority when set", () => {
    const xml = renderSitemap([
      { url: "https://example.com/", changeFrequency: "weekly", priority: 0.8 },
    ]);
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
  });

  it("adds image namespace and entries when images exist", () => {
    const xml = renderSitemap([
      { url: "https://example.com/", images: ["https://example.com/cover.jpg"] },
    ]);
    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain("<image:loc>https://example.com/cover.jpg</image:loc>");
  });

  it("adds xhtml namespace and hreflang links for alternates", () => {
    const xml = renderSitemap([
      {
        url: "https://example.com/",
        alternates: {
          languages: { en: "https://example.com/en", ko: "https://example.com/ko" },
        },
      },
    ]);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain('hreflang="en"');
    expect(xml).toContain('hreflang="ko"');
    expect(xml).toContain('href="https://example.com/ko"');
  });

  it("escapes special XML characters in URLs and image locs", () => {
    const xml = renderSitemap([
      {
        url: "https://example.com/search?q=foo&bar=<baz>",
        images: ["https://cdn.example.com/p?id=1&amp;fmt=jpg"],
      },
    ]);
    expect(xml).toContain("q=foo&amp;bar=&lt;baz&gt;");
    expect(xml).not.toContain("<search?"); // < must have been escaped
  });
});

describe("renderRobots", () => {
  it("renders a single rule group with allow/disallow", () => {
    const robots: Robots = {
      rules: [{ userAgent: "*", allow: "/", disallow: "/admin" }],
    };
    const text = renderRobots(robots);
    expect(text).toContain("User-agent: *");
    expect(text).toContain("Allow: /");
    expect(text).toContain("Disallow: /admin");
  });

  it("handles multiple userAgents and multiple rule groups", () => {
    const robots: Robots = {
      rules: [
        { userAgent: ["Googlebot", "Bingbot"], allow: "/" },
        { userAgent: "BadBot", disallow: "/" },
      ],
    };
    const text = renderRobots(robots);
    expect(text).toContain("User-agent: Googlebot");
    expect(text).toContain("User-agent: Bingbot");
    expect(text).toContain("User-agent: BadBot");
    // Rule groups separated by blank line.
    expect(text.split("\n\n").length).toBeGreaterThanOrEqual(2);
  });

  it("emits Sitemap directive(s) when set", () => {
    const text = renderRobots({
      rules: [{ userAgent: "*", allow: "/" }],
      sitemap: ["https://example.com/sitemap.xml", "https://example.com/sitemap-2.xml"],
    });
    expect(text).toContain("Sitemap: https://example.com/sitemap.xml");
    expect(text).toContain("Sitemap: https://example.com/sitemap-2.xml");
  });

  it("emits Host directive when set", () => {
    const text = renderRobots({
      rules: [{ userAgent: "*", allow: "/" }],
      host: "example.com",
    });
    expect(text).toContain("Host: example.com");
  });

  it("accepts Crawl-delay", () => {
    const text = renderRobots({
      rules: [{ userAgent: "*", allow: "/", crawlDelay: 10 }],
    });
    expect(text).toContain("Crawl-delay: 10");
  });
});

describe("renderManifest", () => {
  it("serializes a minimal valid manifest as JSON", () => {
    const manifest: WebAppManifest = {
      name: "Example App",
      short_name: "App",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    };
    const json = renderManifest(manifest);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("Example App");
    expect(parsed.short_name).toBe("App");
    expect(parsed.icons).toHaveLength(1);
  });

  it("preserves unknown fields (passthrough)", () => {
    const manifest = {
      name: "App",
      short_name: "A",
      icons: [{ src: "/icon.png" }],
      custom_field: "opaque",
    } as WebAppManifest;
    const json = renderManifest(manifest);
    expect(JSON.parse(json).custom_field).toBe("opaque");
  });
});

describe("renderLlmsTxt", () => {
  it("passes through string content verbatim", () => {
    const body = "# Example Site\n\nDocumentation index for LLMs.";
    expect(renderLlmsTxt(body)).toBe(body);
  });

  it("throws a TypeError on non-string input", () => {
    expect(() => renderLlmsTxt(42 as unknown as string)).toThrow(TypeError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Validation (renderValidated)
// ═══════════════════════════════════════════════════════════════════════════

describe("renderValidated — invalid shapes", () => {
  it("sitemap: missing url", () => {
    expect(() =>
      renderValidated("sitemap", [{} as unknown], "app/sitemap.ts")
    ).toThrow(MetadataRouteValidationError);
  });

  it("sitemap: malformed url", () => {
    expect(() =>
      renderValidated("sitemap", [{ url: "not a url" }], "app/sitemap.ts")
    ).toThrow(MetadataRouteValidationError);
  });

  it("sitemap: priority out of range", () => {
    expect(() =>
      renderValidated(
        "sitemap",
        [{ url: "https://example.com/", priority: 1.5 }],
        "app/sitemap.ts"
      )
    ).toThrow(MetadataRouteValidationError);
  });

  it("robots: missing userAgent", () => {
    expect(() =>
      renderValidated(
        "robots",
        { rules: [{ allow: "/" } as unknown] },
        "app/robots.ts"
      )
    ).toThrow(MetadataRouteValidationError);
  });

  it("manifest: missing required name", () => {
    expect(() =>
      renderValidated(
        "manifest",
        { short_name: "A", icons: [{ src: "/icon.png" }] },
        "app/manifest.ts"
      )
    ).toThrow(MetadataRouteValidationError);
  });

  it("manifest: missing icons", () => {
    expect(() =>
      renderValidated(
        "manifest",
        { name: "App", short_name: "A", icons: [] },
        "app/manifest.ts"
      )
    ).toThrow(MetadataRouteValidationError);
  });

  it("llms-txt: non-string input", () => {
    expect(() =>
      renderValidated("llms-txt", { body: "oops" }, "app/llms.txt.ts")
    ).toThrow(MetadataRouteValidationError);
  });

  it("validation error includes the source file in its message", () => {
    try {
      renderValidated("manifest", { icons: [{ src: "" }] }, "app/manifest.ts");
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(MetadataRouteValidationError);
      const e = err as MetadataRouteValidationError;
      expect(e.sourceFile).toBe("app/manifest.ts");
      expect(e.message).toContain("app/manifest.ts");
      expect(e.issues.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dispatcher (handleMetadataRoute)
// ═══════════════════════════════════════════════════════════════════════════

describe("handleMetadataRoute", () => {
  it("wraps a sitemap export into a 200 response with XML content-type", async () => {
    const response = await handleMetadataRoute({
      kind: "sitemap",
      userExport: async () =>
        [{ url: "https://example.com/" }] satisfies Sitemap,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("<urlset");
    expect(body).toContain("https://example.com/");
  });

  it("wraps a robots export", async () => {
    const response = await handleMetadataRoute({
      kind: "robots",
      userExport: () =>
        ({
          rules: [{ userAgent: "*", allow: "/" }],
          sitemap: "https://example.com/sitemap.xml",
        }) satisfies Robots,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("wraps a manifest export with application/manifest+json type", async () => {
    const response = await handleMetadataRoute({
      kind: "manifest",
      userExport: () =>
        ({
          name: "Example",
          short_name: "Ex",
          icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
        }) satisfies WebAppManifest,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/manifest+json; charset=utf-8"
    );
    const parsed = JSON.parse(await response.text());
    expect(parsed.name).toBe("Example");
  });

  it("wraps an llms-txt string export", async () => {
    const response = await handleMetadataRoute({
      kind: "llms-txt",
      userExport: async () => "# Site\n\n- [Docs](/docs): Getting started",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toContain("# Site");
  });

  it("accepts a module namespace { default: fn }", async () => {
    const response = await handleMetadataRoute({
      kind: "sitemap",
      userExport: { default: () => [{ url: "https://example.com/" }] },
    });
    expect(response.status).toBe(200);
  });

  it("applies default Cache-Control: public, max-age=3600", async () => {
    const response = await handleMetadataRoute({
      kind: "llms-txt",
      userExport: () => "hello",
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("honors custom cache string", async () => {
    const response = await handleMetadataRoute({
      kind: "llms-txt",
      userExport: () => "hello",
      cache: "public, max-age=60",
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("omits Cache-Control when cache: false", async () => {
    const response = await handleMetadataRoute({
      kind: "llms-txt",
      userExport: () => "hello",
      cache: false,
    });
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  it("returns 500 with source file + detail when user throws", async () => {
    const response = await handleMetadataRoute({
      kind: "sitemap",
      userExport: async () => {
        throw new Error("database is down");
      },
      sourceFile: "app/sitemap.ts",
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("app/sitemap.ts");
    expect(body).toContain("database is down");
  });

  it("returns 500 when export is not a function", async () => {
    const response = await handleMetadataRoute({
      kind: "sitemap",
      userExport: "wrong shape",
      sourceFile: "app/sitemap.ts",
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("default export must be a function");
    expect(body).toContain("app/sitemap.ts");
  });

  it("returns 500 with validation path when manifest is missing a field", async () => {
    const response = await handleMetadataRoute({
      kind: "manifest",
      userExport: () => ({ name: "", short_name: "A", icons: [{ src: "/icon.png" }] }),
      sourceFile: "app/manifest.ts",
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("app/manifest.ts");
    // The error should quote the offending field.
    expect(body.toLowerCase()).toContain("name");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Performance — 10k entries under 100ms
// ═══════════════════════════════════════════════════════════════════════════

describe("performance", () => {
  it("renders a 10k-entry sitemap in under 100ms", () => {
    const sitemap: Sitemap = Array.from({ length: 10_000 }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      lastModified: new Date(2024, 0, 1, 0, 0, i),
      changeFrequency: "weekly" as const,
      priority: (i % 10) / 10,
    }));
    const start = performance.now();
    const xml = renderSitemap(sitemap);
    const elapsed = performance.now() - start;

    expect(xml.length).toBeGreaterThan(10_000 * 50);
    // Generous bound — our local dev loop hits ~30-50ms. Loose enough
    // that CI on slower hardware won't flake, tight enough to catch
    // any accidental O(n²) regression.
    expect(elapsed).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Static route table integrity
// ═══════════════════════════════════════════════════════════════════════════

describe("METADATA_ROUTES table", () => {
  it("covers all four file-convention routes with expected patterns", () => {
    expect(METADATA_ROUTES.sitemap.pattern).toBe("/sitemap.xml");
    expect(METADATA_ROUTES.robots.pattern).toBe("/robots.txt");
    expect(METADATA_ROUTES["llms-txt"].pattern).toBe("/llms.txt");
    expect(METADATA_ROUTES.manifest.pattern).toBe("/manifest.webmanifest");
  });

  it("exposes the matching Content-Type per route", () => {
    expect(getMetadataRouteMeta("sitemap").contentType).toContain("application/xml");
    expect(getMetadataRouteMeta("robots").contentType).toContain("text/plain");
    expect(getMetadataRouteMeta("llms-txt").contentType).toContain("text/plain");
    expect(getMetadataRouteMeta("manifest").contentType).toContain(
      "application/manifest+json"
    );
  });
});

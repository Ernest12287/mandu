/**
 * Issue #219 — prerender link-crawler asset-extension regression tests.
 *
 * Problem: `extractInternalLinks()` used to enqueue every internal
 * `href` into the render queue. That queue is fed into the SSR fetch
 * handler, whose HTML response is then written to
 * `.mandu/prerendered/<path>/index.html`. Browsers hit markup like
 * `<picture><source srcset="/hero.avif"><img src="/hero.webp"></picture>`
 * and `<a href="/whitepaper.pdf">` all the time, so the crawler would
 * try to "prerender" the image / PDF as HTML, emit an `index.html`
 * under `.mandu/prerendered/hero.webp/`, and corrupt subsequent real
 * requests for that asset.
 *
 * Fix: `extractInternalLinks()` now filters out URLs whose pathname
 * ends with a known non-HTML extension. The default set lives in
 * `DEFAULT_ASSET_EXTENSIONS`; projects can extend or replace it via
 * `ManduConfig.build.crawl.assetExtensions` (routed through
 * `PrerenderCrawlOptions`).
 *
 * These tests exercise the pure helpers — no build harness needed.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ASSET_EXTENSIONS,
  compileCrawlDenylist,
  extractInternalLinks,
  isAssetPathname,
  resolveAssetExtensions,
} from "../../src/bundler/prerender";

describe("prerender asset-extension exclusion — Issue #219", () => {
  describe("DEFAULT_ASSET_EXTENSIONS", () => {
    it("covers the common image / font / document / media / text set", () => {
      // Sanity-check the load-bearing entries. If anyone ever removes
      // one of these, the crawler regresses silently — assert explicitly.
      for (const ext of [
        ".webp",
        ".avif",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".svg",
        ".ico",
        ".pdf",
        ".zip",
        ".mp4",
        ".webm",
        ".mp3",
        ".wav",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".eot",
        ".css",
        ".js",
        ".map",
        ".json",
        ".xml",
        ".txt",
      ]) {
        expect(DEFAULT_ASSET_EXTENSIONS).toContain(ext);
      }
    });

    it("every entry is lowercase + dot-prefixed", () => {
      for (const ext of DEFAULT_ASSET_EXTENSIONS) {
        expect(ext.startsWith(".")).toBe(true);
        expect(ext).toBe(ext.toLowerCase());
      }
    });
  });

  describe("resolveAssetExtensions", () => {
    it("returns defaults when options omitted", () => {
      const set = resolveAssetExtensions(undefined);
      expect(set.has(".webp")).toBe(true);
      expect(set.has(".pdf")).toBe(true);
      expect(set.size).toBe(DEFAULT_ASSET_EXTENSIONS.length);
    });

    it("merges user extras with defaults", () => {
      const set = resolveAssetExtensions({ assetExtensions: [".apk", ".dmg"] });
      expect(set.has(".webp")).toBe(true);
      expect(set.has(".apk")).toBe(true);
      expect(set.has(".dmg")).toBe(true);
    });

    it("normalizes entries (adds leading dot, lowercases)", () => {
      const set = resolveAssetExtensions({ assetExtensions: ["APK", ".DmG", "pdf"] });
      expect(set.has(".apk")).toBe(true);
      expect(set.has(".dmg")).toBe(true);
      expect(set.has(".pdf")).toBe(true);
      expect(set.has("APK")).toBe(false); // not raw
    });

    it("replaces defaults when replaceDefaultAssetExtensions=true", () => {
      const set = resolveAssetExtensions({
        assetExtensions: [".only-this"],
        replaceDefaultAssetExtensions: true,
      });
      expect(set.has(".only-this")).toBe(true);
      expect(set.has(".webp")).toBe(false);
      expect(set.has(".pdf")).toBe(false);
      expect(set.size).toBe(1);
    });

    it("replaceDefaultAssetExtensions=true with empty list disables the filter", () => {
      const set = resolveAssetExtensions({
        assetExtensions: [],
        replaceDefaultAssetExtensions: true,
      });
      expect(set.size).toBe(0);
    });
  });

  describe("isAssetPathname", () => {
    const assetExtensions = resolveAssetExtensions(undefined);

    it("returns true for common asset extensions", () => {
      expect(isAssetPathname("/hero.webp", assetExtensions)).toBe(true);
      expect(isAssetPathname("/hero.avif", assetExtensions)).toBe(true);
      expect(isAssetPathname("/whitepaper.pdf", assetExtensions)).toBe(true);
      expect(isAssetPathname("/logo.svg", assetExtensions)).toBe(true);
    });

    it("returns false for HTML routes", () => {
      expect(isAssetPathname("/about", assetExtensions)).toBe(false);
      expect(isAssetPathname("/docs/intro", assetExtensions)).toBe(false);
      expect(isAssetPathname("/", assetExtensions)).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isAssetPathname("/HERO.WEBP", assetExtensions)).toBe(true);
      expect(isAssetPathname("/Paper.Pdf", assetExtensions)).toBe(true);
    });

    it("ignores query strings + hash fragments", () => {
      expect(isAssetPathname("/hero.webp?v=2", assetExtensions)).toBe(true);
      expect(isAssetPathname("/hero.webp#frag", assetExtensions)).toBe(true);
      expect(isAssetPathname("/hero.webp?v=2#frag", assetExtensions)).toBe(true);
    });

    it("returns false when set is empty (filter disabled)", () => {
      expect(isAssetPathname("/hero.webp", new Set())).toBe(false);
    });

    it("does not treat dotfile-style basenames as assets", () => {
      // `.htaccess` has no non-dot character before the dot → not an
      // extension, so the crawler wouldn't strip it. (Dotfile URLs are
      // unusual on the web; we just don't want a crash.)
      expect(isAssetPathname("/.htaccess", assetExtensions)).toBe(false);
    });

    it("treats extensionless paths with dots in a middle segment as non-assets", () => {
      // Something like `/docs/v1.2/guide` — no extension on basename.
      expect(isAssetPathname("/docs/v1.2/guide", assetExtensions)).toBe(false);
    });
  });

  describe("extractInternalLinks (integration with Issue #213)", () => {
    const denylist = compileCrawlDenylist(undefined);
    const defaultAssets = resolveAssetExtensions(undefined);

    it("skips .webp / .avif / .png image URLs", () => {
      const html =
        `<a href="/hero.webp">a</a>` +
        `<a href="/hero.avif">b</a>` +
        `<a href="/logo.png">c</a>` +
        `<a href="/about">d</a>`;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      expect(out).toEqual(["/about"]);
    });

    it("skips <picture>/<source srcset> companion href (realistic regression case)", () => {
      // The crawler only reads `href=` (not `src`/`srcset`) — but users
      // often wrap an asset in `<a href="/hero.webp">` for downloads.
      // This was the exact shape that triggered #219.
      const html = `
        <picture>
          <source srcset="/hero.avif" type="image/avif">
          <source srcset="/hero.webp" type="image/webp">
          <a href="/hero.webp"><img src="/hero.webp"></a>
        </picture>
        <a href="/home">home</a>
      `;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      expect(out).toContain("/home");
      expect(out).not.toContain("/hero.webp");
      expect(out).not.toContain("/hero.avif");
    });

    it("skips PDF / zip / media / font URLs", () => {
      const html =
        `<a href="/whitepaper.pdf">a</a>` +
        `<a href="/bundle.zip">b</a>` +
        `<a href="/intro.mp4">c</a>` +
        `<a href="/font.woff2">d</a>` +
        `<a href="/article">e</a>`;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      expect(out).toEqual(["/article"]);
    });

    it("does NOT skip real HTML routes", () => {
      const html = `<a href="/about">a</a><a href="/docs/intro">b</a>`;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      expect(out).toEqual(["/about", "/docs/intro"]);
    });

    it("asset extension match is case-insensitive in HTML", () => {
      const html = `<a href="/HERO.WEBP">a</a><a href="/Paper.PDF">b</a><a href="/real">c</a>`;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      // `normalizeCrawlPath` lowercases before the extension check,
      // so `.WEBP` → `.webp` and gets filtered.
      expect(out).toEqual(["/real"]);
    });

    it("asset URL with query string is still filtered", () => {
      const html = `<a href="/hero.webp?v=2">a</a><a href="/about?ref=nav">b</a>`;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      // `/about?ref=nav` → `/about`; `/hero.webp?v=2` → `/hero.webp` → skipped.
      expect(out).toEqual(["/about"]);
    });

    it("asset URL with hash fragment is still filtered", () => {
      const html = `<a href="/hero.webp#alt">a</a><a href="/docs#section">b</a>`;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      expect(out).toEqual(["/docs"]);
    });

    it("custom assetExtensions extends the default set", () => {
      const customAssets = resolveAssetExtensions({
        assetExtensions: [".apk", ".dmg"],
      });
      const html =
        `<a href="/app.apk">a</a>` +
        `<a href="/installer.dmg">b</a>` +
        `<a href="/hero.webp">c</a>` + // still a default asset
        `<a href="/download">d</a>`;
      const out = extractInternalLinks(html, denylist, customAssets);
      expect(out).toEqual(["/download"]);
    });

    it("replaceDefaultAssetExtensions=true drops the default filter", () => {
      const minimalAssets = resolveAssetExtensions({
        assetExtensions: [".apk"],
        replaceDefaultAssetExtensions: true,
      });
      const html = `<a href="/app.apk">a</a><a href="/hero.webp">b</a><a href="/about">c</a>`;
      const out = extractInternalLinks(html, denylist, minimalAssets);
      // `.webp` is no longer in the set; only `.apk` is filtered.
      expect(out).toContain("/hero.webp");
      expect(out).toContain("/about");
      expect(out).not.toContain("/app.apk");
    });

    it("empty asset-extension set disables the filter entirely", () => {
      const emptySet = new Set<string>();
      const html = `<a href="/hero.webp">a</a><a href="/about">b</a>`;
      const out = extractInternalLinks(html, denylist, emptySet);
      expect(out).toEqual(["/hero.webp", "/about"]);
    });

    it("default overload (no third arg) still filters asset URLs", () => {
      // Backward-compat check: users calling `extractInternalLinks(html, denylist)`
      // without threading the crawler config through must still get the fix.
      const html = `<a href="/hero.webp">a</a><a href="/about">b</a>`;
      const out = extractInternalLinks(html, denylist);
      expect(out).toEqual(["/about"]);
    });

    it("combines with #213 code-region stripping: <pre> asset href is double-ignored", () => {
      const html = `
        <pre><code>&lt;img src="/ghost.webp"&gt;</code></pre>
        <a href="/real-hero.webp">download</a>
        <a href="/home">go home</a>
      `;
      const out = extractInternalLinks(html, denylist, defaultAssets);
      // `/ghost.webp` stripped by stripCodeRegions; `/real-hero.webp`
      // filtered by asset extension; only `/home` survives.
      expect(out).toEqual(["/home"]);
    });
  });
});

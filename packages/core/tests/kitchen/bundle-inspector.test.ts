/**
 * Plan 18 P2-6 — Bundle inspector unit tests.
 *
 * Each test mints an isolated tmp project with a synthetic
 * .mandu/manifest.json + dummy bundle files at the declared paths so we
 * can assert byte sizing without a real build.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { buildBundleReport } from "../../src/kitchen/api/bundle-inspector";

function write(rootDir: string, rel: string, body: string | Buffer): void {
  const abs = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

describe("buildBundleReport", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-inspector-"));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("reports loaded:false when manifest is missing", async () => {
    const report = await buildBundleReport(rootDir);
    expect(report.loaded).toBe(false);
    expect(report.reason).toMatch(/manifest.json/);
    expect(report.bundles).toEqual([]);
    expect(report.islands).toEqual([]);
  });

  it("reports loaded:false when manifest is malformed JSON", async () => {
    write(rootDir, ".mandu/manifest.json", "{not json");
    const report = await buildBundleReport(rootDir);
    expect(report.loaded).toBe(false);
  });

  it("returns sized bundles and islands when files exist on disk", async () => {
    const manifest = {
      version: 1,
      buildTime: "2026-05-12T00:00:00.000Z",
      env: "production",
      bundles: {
        home: { js: "/.mandu/client/home.js", dependencies: [], priority: "visible" },
      },
      islands: {
        counter: { js: "/.mandu/client/counter.island.js", route: "home", priority: "visible" },
        gallery: { js: "/.mandu/client/gallery.island.js", route: "home", priority: "idle" },
      },
      shared: {
        runtime: "/.mandu/client/runtime.js",
        vendor: "/.mandu/client/vendor.js",
      },
    };
    write(rootDir, ".mandu/manifest.json", JSON.stringify(manifest));
    write(rootDir, ".mandu/client/home.js", "h".repeat(500));
    write(rootDir, ".mandu/client/counter.island.js", "c".repeat(1500));
    write(rootDir, ".mandu/client/gallery.island.js", "g".repeat(800));
    write(rootDir, ".mandu/client/runtime.js", "r".repeat(2000));
    write(rootDir, ".mandu/client/vendor.js", "v".repeat(50_000));

    const report = await buildBundleReport(rootDir);

    expect(report.loaded).toBe(true);
    expect(report.manifest?.env).toBe("production");

    // Islands sorted biggest first
    expect(report.islands.map((i) => i.islandId)).toEqual(["counter", "gallery"]);
    expect(report.islands[0].bytes).toBe(1500);
    expect(report.islands[1].bytes).toBe(800);

    expect(report.bundles).toHaveLength(1);
    expect(report.bundles[0].bytes).toBe(500);

    expect(report.shared?.runtime.bytes).toBe(2000);
    expect(report.shared?.vendor.bytes).toBe(50_000);

    expect(report.totals.totalBytes).toBe(500 + 1500 + 800 + 2000 + 50_000);
    expect(report.totals.islandCount).toBe(2);
    expect(report.totals.bundleCount).toBe(1);
    expect(report.totals.largestIsland?.id).toBe("counter");
    expect(report.totals.largestBundle?.routeId).toBe("home");
  });

  it("treats missing on-disk files as 0 bytes without throwing", async () => {
    const manifest = {
      version: 1,
      buildTime: "2026-05-12T00:00:00.000Z",
      env: "production",
      bundles: {
        a: { js: "/.mandu/client/missing-a.js", dependencies: [], priority: "visible" },
      },
      islands: {},
      shared: {
        runtime: "/.mandu/client/missing-runtime.js",
        vendor: "/.mandu/client/missing-vendor.js",
      },
    };
    write(rootDir, ".mandu/manifest.json", JSON.stringify(manifest));

    const report = await buildBundleReport(rootDir);

    expect(report.loaded).toBe(true);
    expect(report.bundles[0].bytes).toBe(0);
    expect(report.shared?.runtime.bytes).toBe(0);
    expect(report.totals.totalBytes).toBe(0);
  });
});

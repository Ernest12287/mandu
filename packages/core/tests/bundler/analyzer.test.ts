/**
 * Phase 18.η — Bundle analyzer regression tests.
 *
 * Covers:
 *   - Shape invariants of `AnalyzeReport`
 *   - Empty manifest → report with zero islands, no crash
 *   - Single-island measurement (raw + gzip)
 *   - Multi-island shared-chunk attribution + dedupe savings
 *   - Sourcemap parsing → top-N modules (with + without sourcesContent)
 *   - `normalizeSourcePath` folding `node_modules/**` and `../` prefixes
 *   - HTML render is self-contained, escapes user content, references every island
 *   - JSON/HTML on-disk writes land in `.mandu/analyze/`
 *   - Sort order stability (largest island first, heaviest dep tracked)
 *   - Missing bundle file degrades to size=0 without throwing
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import zlib from "zlib";

import {
  analyzeBundle,
  fmtBytes,
  normalizeSourcePath,
  renderAnalyzeHtml,
  writeAnalyzeReport,
} from "../../src/bundler/analyzer";
import type { BundleManifest } from "../../src/bundler/types";
import type { AnalyzeReport } from "../../src/bundler/analyzer";

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeEmptyManifest(): BundleManifest {
  return {
    version: 1,
    buildTime: new Date().toISOString(),
    env: "production",
    bundles: {},
    shared: { runtime: "", vendor: "" },
    importMap: { imports: {} },
  };
}

async function writeClientFile(
  rootDir: string,
  relPath: string,
  body: string
): Promise<number> {
  const abs = path.join(rootDir, ".mandu", "client", relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, "utf8");
  return Buffer.byteLength(body, "utf8");
}

async function writeSourceMap(
  rootDir: string,
  jsRelPath: string,
  sources: { path: string; content: string }[]
): Promise<void> {
  const abs = path.join(rootDir, ".mandu", "client", `${jsRelPath}.map`);
  await mkdir(path.dirname(abs), { recursive: true });
  const map = {
    version: 3,
    sources: sources.map((s) => s.path),
    sourcesContent: sources.map((s) => s.content),
    mappings: "",
  };
  await writeFile(abs, JSON.stringify(map), "utf8");
}

// ── Tests ──────────────────────────────────────────────────────────────────

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mandu-analyzer-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("analyzeBundle — empty manifest", () => {
  test("returns zero islands + empty shared without throwing", async () => {
    const dir = await mkdtemp(path.join(root, "empty-"));
    const report = await analyzeBundle(dir, makeEmptyManifest());
    expect(report.islands).toEqual([]);
    expect(report.shared).toEqual([]);
    expect(report.summary.islandCount).toBe(0);
    expect(report.summary.sharedCount).toBe(0);
    expect(report.summary.largestIsland).toBeNull();
    expect(report.summary.heaviestDep).toBeNull();
    expect(report.summary.version).toBe(1);
  });
});

describe("analyzeBundle — single island + shared chunks", () => {
  test("measures raw + real gzip and records shared usage", async () => {
    const dir = await mkdtemp(path.join(root, "single-"));
    const homeBody = "home".repeat(2000); // 8 KB, compressible
    const vendorBody = "vendor".repeat(5000); // 30 KB
    const runtimeBody = "runtime".repeat(500);
    const homeRaw = await writeClientFile(dir, "home.js", homeBody);
    const vendorRaw = await writeClientFile(dir, "_vendor.js", vendorBody);
    const runtimeRaw = await writeClientFile(dir, "_runtime.js", runtimeBody);

    const manifest: BundleManifest = {
      version: 1,
      buildTime: new Date().toISOString(),
      env: "production",
      bundles: {
        home: {
          js: "/.mandu/client/home.js",
          dependencies: [],
          priority: "visible",
        },
      },
      shared: {
        runtime: "/.mandu/client/_runtime.js",
        vendor: "/.mandu/client/_vendor.js",
      },
    };
    const report = await analyzeBundle(dir, manifest);

    expect(report.islands.length).toBe(1);
    const home = report.islands[0];
    expect(home.name).toBe("home");
    expect(home.totalRaw).toBe(homeRaw);
    // Expect real gzip produces < raw for repetitive content.
    const expectedGz = zlib.gzipSync(homeBody, { level: 9 }).byteLength;
    expect(home.totalGz).toBe(expectedGz);
    expect(home.totalGz).toBeLessThan(home.totalRaw);
    expect(home.shared).toContain("runtime");
    expect(home.shared).toContain("vendor");

    const vendor = report.shared.find((s) => s.id === "vendor");
    expect(vendor?.size).toBe(vendorRaw);
    expect(vendor?.usedBy).toEqual(["home"]);
    const runtime = report.shared.find((s) => s.id === "runtime");
    expect(runtime?.size).toBe(runtimeRaw);

    // Summary totals = sum of islands + shared.
    expect(report.summary.totalRaw).toBe(homeRaw + vendorRaw + runtimeRaw);
    expect(report.summary.largestIsland?.name).toBe("home");
  });
});

describe("analyzeBundle — multi-island shared chunk + dedupe savings", () => {
  test("shared chunk is attributed to every island; dedupe = (N-1)*size", async () => {
    const dir = await mkdtemp(path.join(root, "multi-"));
    await writeClientFile(dir, "a.js", "a".repeat(1024));
    await writeClientFile(dir, "b.js", "b".repeat(2048));
    await writeClientFile(dir, "_vendor.js", "x".repeat(4096));
    await writeClientFile(dir, "_runtime.js", "r".repeat(512));

    const manifest: BundleManifest = {
      version: 1,
      buildTime: new Date().toISOString(),
      env: "production",
      bundles: {
        a: { js: "/.mandu/client/a.js", dependencies: [], priority: "immediate" },
        b: { js: "/.mandu/client/b.js", dependencies: [], priority: "idle" },
      },
      shared: {
        runtime: "/.mandu/client/_runtime.js",
        vendor: "/.mandu/client/_vendor.js",
      },
    };
    const report = await analyzeBundle(dir, manifest);

    const vendor = report.shared.find((s) => s.id === "vendor")!;
    expect(vendor.usedBy.sort()).toEqual(["a", "b"]);
    // dedupe = (2-1)*vendor + (2-1)*runtime
    expect(report.summary.dedupeSavings).toBe(4096 + 512);
    // Largest island (b=2048) ranked first.
    expect(report.islands[0].name).toBe("b");
    expect(report.islands[1].name).toBe("a");
  });
});

describe("analyzeBundle — sourcemap module breakdown", () => {
  test("parses top modules and normalises node_modules paths", async () => {
    const dir = await mkdtemp(path.join(root, "sm-"));
    const body = "ab".repeat(1024);
    await writeClientFile(dir, "home.js", body);
    await writeClientFile(dir, "_runtime.js", "r");
    await writeClientFile(dir, "_vendor.js", "v");
    await writeSourceMap(dir, "home.js", [
      {
        path: "../../../node_modules/react-dom/index.js",
        content: "r".repeat(4000),
      },
      { path: "../../src/app/home/page.tsx", content: "p".repeat(1500) },
      { path: "../../src/utils/trivial.ts", content: "t".repeat(50) },
    ]);

    const manifest: BundleManifest = {
      version: 1,
      buildTime: new Date().toISOString(),
      env: "production",
      bundles: {
        home: { js: "/.mandu/client/home.js", dependencies: [], priority: "visible" },
      },
      shared: {
        runtime: "/.mandu/client/_runtime.js",
        vendor: "/.mandu/client/_vendor.js",
      },
    };
    const report = await analyzeBundle(dir, manifest);
    const home = report.islands[0];
    expect(home.modules.length).toBe(3);
    // Sorted desc by size.
    expect(home.modules[0].path).toBe("react-dom/index.js");
    expect(home.modules[0].size).toBe(4000);
    expect(home.modules[1].path).toBe("src/app/home/page.tsx");
    expect(home.modules[2].size).toBe(50);
    // heaviestDep = react-dom/index.js
    expect(report.summary.heaviestDep?.path).toBe("react-dom/index.js");
  });

  test("missing sourcemap → modules: []", async () => {
    const dir = await mkdtemp(path.join(root, "sm-missing-"));
    await writeClientFile(dir, "home.js", "x".repeat(100));
    await writeClientFile(dir, "_runtime.js", "r");
    await writeClientFile(dir, "_vendor.js", "v");
    const manifest: BundleManifest = {
      version: 1,
      buildTime: new Date().toISOString(),
      env: "production",
      bundles: {
        home: { js: "/.mandu/client/home.js", dependencies: [], priority: "visible" },
      },
      shared: {
        runtime: "/.mandu/client/_runtime.js",
        vendor: "/.mandu/client/_vendor.js",
      },
    };
    const report = await analyzeBundle(dir, manifest);
    expect(report.islands[0].modules).toEqual([]);
  });

  test("sourcemap without sourcesContent → modules: []", async () => {
    const dir = await mkdtemp(path.join(root, "sm-nocontent-"));
    await writeClientFile(dir, "home.js", "x".repeat(100));
    await writeClientFile(dir, "_runtime.js", "r");
    await writeClientFile(dir, "_vendor.js", "v");
    const mapPath = path.join(dir, ".mandu/client/home.js.map");
    await writeFile(
      mapPath,
      JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "" }),
      "utf8"
    );
    const manifest: BundleManifest = {
      version: 1,
      buildTime: new Date().toISOString(),
      env: "production",
      bundles: {
        home: { js: "/.mandu/client/home.js", dependencies: [], priority: "visible" },
      },
      shared: {
        runtime: "/.mandu/client/_runtime.js",
        vendor: "/.mandu/client/_vendor.js",
      },
    };
    const report = await analyzeBundle(dir, manifest);
    expect(report.islands[0].modules).toEqual([]);
  });
});

describe("analyzeBundle — missing bundle file degrades gracefully", () => {
  test("manifest references nonexistent JS → size=0, no throw", async () => {
    const dir = await mkdtemp(path.join(root, "missing-"));
    const manifest: BundleManifest = {
      version: 1,
      buildTime: new Date().toISOString(),
      env: "production",
      bundles: {
        ghost: {
          js: "/.mandu/client/ghost.js",
          dependencies: [],
          priority: "visible",
        },
      },
      shared: {
        runtime: "/.mandu/client/_runtime.js",
        vendor: "/.mandu/client/_vendor.js",
      },
    };
    const report = await analyzeBundle(dir, manifest);
    expect(report.islands[0].totalRaw).toBe(0);
    expect(report.islands[0].totalGz).toBe(0);
  });
});

describe("normalizeSourcePath", () => {
  test("strips node_modules prefix", () => {
    expect(
      normalizeSourcePath("../../../node_modules/react/index.js")
    ).toBe("react/index.js");
  });
  test("preserves bun: specifiers", () => {
    expect(normalizeSourcePath("bun:react-dom")).toBe("bun:react-dom");
  });
  test("strips relative prefix", () => {
    expect(normalizeSourcePath("../../src/app/page.tsx")).toBe(
      "src/app/page.tsx"
    );
  });
  test("normalises windows backslashes", () => {
    expect(normalizeSourcePath("..\\src\\app\\page.tsx")).toBe(
      "src/app/page.tsx"
    );
  });
});

describe("renderAnalyzeHtml", () => {
  function makeReport(): AnalyzeReport {
    return {
      islands: [
        {
          name: "home",
          js: "/.mandu/client/home.js",
          totalRaw: 100_000,
          totalGz: 30_000,
          priority: "visible",
          shared: ["runtime", "vendor"],
          modules: [
            { path: "react/index.js", size: 40_000, gz: 12_000 },
            { path: "src/home.tsx", size: 10_000, gz: 3_000 },
          ],
        },
      ],
      shared: [
        {
          id: "vendor",
          js: "/.mandu/client/_vendor.js",
          size: 50_000,
          gz: 18_000,
          usedBy: ["home"],
        },
      ],
      summary: {
        totalRaw: 150_000,
        totalGz: 48_000,
        largestIsland: { name: "home", totalRaw: 100_000 },
        heaviestDep: { path: "react/index.js", size: 40_000 },
        islandCount: 1,
        sharedCount: 1,
        dedupeSavings: 0,
        version: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
  }

  test("is self-contained: no http:// or cdn references", () => {
    const html = renderAnalyzeHtml(makeReport());
    expect(html).toStartWith("<!doctype html>");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("cdn.");
    expect(html).not.toContain("unpkg.com");
  });

  test("includes every island + shared chunk name", () => {
    const html = renderAnalyzeHtml(makeReport());
    expect(html).toContain("home");
    expect(html).toContain("vendor");
    expect(html).toContain("react/index.js");
  });

  test("escapes user-provided strings (xss defence)", () => {
    const r = makeReport();
    r.islands[0].name = "<script>alert(1)</script>";
    const html = renderAnalyzeHtml(r);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("size stays under 500 KB for small reports", () => {
    const html = renderAnalyzeHtml(makeReport());
    expect(html.length).toBeLessThan(500 * 1024);
  });
});

describe("writeAnalyzeReport", () => {
  test("writes both json and html into .mandu/analyze/", async () => {
    const dir = await mkdtemp(path.join(root, "write-"));
    const report: AnalyzeReport = {
      islands: [],
      shared: [],
      summary: {
        totalRaw: 0,
        totalGz: 0,
        largestIsland: null,
        heaviestDep: null,
        islandCount: 0,
        sharedCount: 0,
        dedupeSavings: 0,
        version: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { jsonPath, htmlPath } = await writeAnalyzeReport(dir, report);
    expect(jsonPath).toBe(path.join(dir, ".mandu/analyze/report.json"));
    expect(htmlPath).toBe(path.join(dir, ".mandu/analyze/report.html"));
    const jsonRead = JSON.parse(await readFile(jsonPath, "utf8"));
    expect(jsonRead.summary.version).toBe(1);
    const htmlRead = await readFile(htmlPath!, "utf8");
    expect(htmlRead).toStartWith("<!doctype html>");
  });

  test("html:false skips HTML render", async () => {
    const dir = await mkdtemp(path.join(root, "jsononly-"));
    const report: AnalyzeReport = {
      islands: [],
      shared: [],
      summary: {
        totalRaw: 0,
        totalGz: 0,
        largestIsland: null,
        heaviestDep: null,
        islandCount: 0,
        sharedCount: 0,
        dedupeSavings: 0,
        version: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { jsonPath, htmlPath } = await writeAnalyzeReport(dir, report, {
      html: false,
    });
    expect(htmlPath).toBeNull();
    const exists = await Bun.file(jsonPath).exists();
    expect(exists).toBe(true);
  });
});

describe("fmtBytes", () => {
  test("formats in B / KB / MB brackets", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1500)).toBe("1.5 KB");
    expect(fmtBytes(1024 * 1024 * 3.5)).toBe("3.50 MB");
  });
});

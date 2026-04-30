/**
 * Issue #250 M5 — `.deploy()` DSL + extractor tests.
 *
 * Verifies (a) the chainable `.deploy()` method on ManduFilling and
 * (b) the build-time extractor that flows the captured intent into
 * the cache as `source: "explicit"`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractExplicitIntents,
  mergeExplicitIntents,
} from "../../../src/deploy/inference/filling-extract";
import { emptyDeployIntentCache } from "../../../src/deploy/cache";
import { Mandu } from "../../../src/index";
import type { RoutesManifest, RouteSpec } from "../../../src/spec/schema";

describe("Mandu.filling().deploy()", () => {
  it("captures the intent on the instance", () => {
    const filling = Mandu.filling().deploy({
      runtime: "edge",
      regions: ["icn1"],
    });
    expect(filling.getDeployIntent()).toEqual({
      runtime: "edge",
      regions: ["icn1"],
    });
  });

  it("rejects invalid runtime at call time (loud failure)", () => {
    expect(() =>
      Mandu.filling().deploy({ runtime: "lambda" as never }),
    ).toThrow();
  });

  it("returns this for chaining", () => {
    const filling = Mandu.filling()
      .deploy({ runtime: "static" })
      .purpose("docs page");
    expect(filling.getSemanticMetadata().purpose).toBe("docs page");
    expect(filling.getDeployIntent()?.runtime).toBe("static");
  });

  it("returns undefined when never called", () => {
    expect(Mandu.filling().getDeployIntent()).toBeUndefined();
  });
});

describe("extractExplicitIntents — happy path via injected importer", () => {
  it("captures intents from default-exported filling modules", async () => {
    const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-extract-"));
    try {
      const manifest: RoutesManifest = {
        version: 1,
        routes: [
          {
            id: "api-embed",
            pattern: "/api/embed",
            module: "app/api/embed/route.ts",
            kind: "api",
          } as RouteSpec,
          {
            id: "api-search",
            pattern: "/api/search",
            module: "app/api/search/route.ts",
            kind: "api",
          } as RouteSpec,
          {
            id: "no-deploy",
            pattern: "/api/health",
            module: "app/api/health/route.ts",
            kind: "api",
          } as RouteSpec,
        ],
      };
      // Touch each module file so the existence check passes.
      for (const r of manifest.routes) {
        await fs.mkdir(path.dirname(path.join(TEST_DIR, r.module)), {
          recursive: true,
        });
        await fs.writeFile(path.join(TEST_DIR, r.module), "// placeholder");
      }

      // Inject an importer that returns synthetic filling-like
      // defaults instead of actually importing the placeholder files.
      const importer = async (fileUrl: string) => {
        if (fileUrl.includes("api/embed")) {
          return {
            default: {
              getDeployIntent: () => ({ runtime: "bun" }),
            },
          };
        }
        if (fileUrl.includes("api/search")) {
          return {
            default: {
              getDeployIntent: () => ({
                runtime: "edge",
                regions: ["icn1", "iad1"],
              }),
            },
          };
        }
        // health → no .deploy() call.
        return { default: { getDeployIntent: () => undefined } };
      };

      const result = await extractExplicitIntents(TEST_DIR, manifest, { importer });
      expect(result.errors).toEqual([]);
      expect(result.entries).toHaveLength(2);
      const embed = result.entries.find((e) => e.routeId === "api-embed");
      expect(embed?.intent.runtime).toBe("bun");
      const search = result.entries.find((e) => e.routeId === "api-search");
      expect(search?.intent.regions).toEqual(["icn1", "iad1"]);
    } finally {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("returns an error entry when import throws", async () => {
    const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-extract-"));
    try {
      const manifest: RoutesManifest = {
        version: 1,
        routes: [
          {
            id: "broken",
            pattern: "/broken",
            module: "app/broken.ts",
            kind: "api",
          } as RouteSpec,
        ],
      };
      await fs.mkdir(path.dirname(path.join(TEST_DIR, "app/broken.ts")), { recursive: true });
      await fs.writeFile(path.join(TEST_DIR, "app/broken.ts"), "//placeholder");
      const result = await extractExplicitIntents(TEST_DIR, manifest, {
        importer: async () => {
          throw new Error("syntax error");
        },
      });
      expect(result.entries).toEqual([]);
      expect(result.errors[0]?.routeId).toBe("broken");
      expect(result.errors[0]?.reason).toContain("syntax error");
    } finally {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("ignores modules whose default export is not filling-like", async () => {
    const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-extract-"));
    try {
      const manifest: RoutesManifest = {
        version: 1,
        routes: [
          {
            id: "page",
            pattern: "/about",
            module: "app/about/page.tsx",
            kind: "page",
            componentModule: "app/about/page.tsx",
          } as RouteSpec,
        ],
      };
      await fs.mkdir(path.dirname(path.join(TEST_DIR, "app/about/page.tsx")), { recursive: true });
      await fs.writeFile(path.join(TEST_DIR, "app/about/page.tsx"), "//placeholder");
      const result = await extractExplicitIntents(TEST_DIR, manifest, {
        importer: async () => ({
          default: function Page() {
            return null;
          },
        }),
      });
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("skips routes whose module file does not exist (skipMissing default)", async () => {
    const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-extract-"));
    try {
      const manifest: RoutesManifest = {
        version: 1,
        routes: [
          {
            id: "ghost",
            pattern: "/ghost",
            module: "app/ghost/route.ts",
            kind: "api",
          } as RouteSpec,
        ],
      };
      const result = await extractExplicitIntents(TEST_DIR, manifest);
      expect(result.entries).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    }
  });
});

describe("mergeExplicitIntents", () => {
  it("marks captured entries as source:explicit and overwrites prior cache rows", async () => {
    const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-merge-"));
    try {
      const manifest: RoutesManifest = {
        version: 1,
        routes: [
          {
            id: "api-embed",
            pattern: "/api/embed",
            module: "app/api/embed/route.ts",
            kind: "api",
          } as RouteSpec,
        ],
      };
      await fs.mkdir(path.dirname(path.join(TEST_DIR, "app/api/embed/route.ts")), { recursive: true });
      await fs.writeFile(path.join(TEST_DIR, "app/api/embed/route.ts"), "// any content");

      const previous = emptyDeployIntentCache();
      previous.intents["api-embed"] = {
        intent: { runtime: "edge", cache: "no-store", visibility: "public" },
        source: "inferred",
        rationale: "previous heuristic",
        sourceHash: "x".repeat(64),
      };

      const merged = await mergeExplicitIntents(
        previous,
        [
          {
            routeId: "api-embed",
            pattern: "/api/embed",
            intent: { runtime: "bun", cache: "no-store", visibility: "public" },
          },
        ],
        TEST_DIR,
        manifest,
      );

      const entry = merged.intents["api-embed"]!;
      expect(entry.source).toBe("explicit");
      expect(entry.intent.runtime).toBe("bun");
      // sourceHash is now the file hash, not the placeholder.
      expect(entry.sourceHash).not.toBe("x".repeat(64));
      expect(entry.sourceHash.length).toBe(64);
    } finally {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("is a no-op when there are no entries", async () => {
    const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-merge-"));
    try {
      const previous = emptyDeployIntentCache();
      const merged = await mergeExplicitIntents(
        previous,
        [],
        TEST_DIR,
        { version: 1, routes: [] },
      );
      expect(merged).toBe(previous);
    } finally {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    }
  });
});

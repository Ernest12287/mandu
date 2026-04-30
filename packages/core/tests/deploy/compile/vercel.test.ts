/**
 * Issue #250 M3 — Vercel compiler tests.
 *
 * Pin the manifest + intent → vercel.json mapping as the contract
 * adapters depend on. Cover:
 *
 *   - all-static manifest → no functions block, headers only
 *   - mixed runtime → functions block with edge / bun / node entries
 *   - cache directives → Cache-Control headers per route
 *   - missing intent → VercelCompileError listing the offender
 *   - invalid `static` declaration → VercelCompileError
 *   - overrides.vercel shallow-merges into the function entry
 *   - timeout (ms) → maxDuration (s) conversion
 *   - regions / private visibility → warning surfaces
 */

import { describe, it, expect } from "bun:test";
import {
  compileVercelJson,
  renderVercelJsonFromCompile,
  VercelCompileError,
} from "../../../src/deploy/compile/vercel";
import type { DeployIntentCache } from "../../../src/deploy/cache";
import type { RoutesManifest, RouteSpec } from "../../../src/spec/schema";

const FIXED_HASH = "h".repeat(64);

function staticIntent(): DeployIntentCache["intents"][string] {
  return {
    intent: {
      runtime: "static",
      cache: { sMaxAge: 31_536_000, swr: 86_400 },
      visibility: "public",
    },
    source: "inferred",
    rationale: "non-dynamic page",
    sourceHash: FIXED_HASH,
  };
}

function edgeIntent(
  overrides?: Partial<DeployIntentCache["intents"][string]["intent"]>,
): DeployIntentCache["intents"][string] {
  return {
    intent: {
      runtime: "edge",
      cache: "no-store",
      visibility: "public",
      ...overrides,
    },
    source: "inferred",
    rationale: "stateless API",
    sourceHash: FIXED_HASH,
  };
}

const baseManifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "index",
      pattern: "/",
      module: "app/page.tsx",
      kind: "page",
      componentModule: "app/page.tsx",
    } as RouteSpec,
    {
      id: "api-embed",
      pattern: "/api/embed",
      module: "app/api/embed/route.ts",
      kind: "api",
    } as RouteSpec,
  ],
};

const baseCache: DeployIntentCache = {
  version: 1,
  generatedAt: "2026-04-30T00:00:00.000Z",
  brainModel: "heuristic",
  intents: {
    index: staticIntent(),
    "api-embed": edgeIntent(),
  },
};

describe("compileVercelJson — happy paths", () => {
  it("all-static manifest emits no functions block", () => {
    const cache: DeployIntentCache = {
      ...baseCache,
      intents: { index: staticIntent() },
    };
    const manifest: RoutesManifest = { version: 1, routes: [baseManifest.routes[0]!] };

    const r = compileVercelJson(manifest, cache, { projectName: "site" });
    expect(r.config.functions).toBeUndefined();
    expect(r.config.outputDirectory).toBe("dist");
    expect(r.config.buildCommand).toContain("--static");
    // Bundle long-cache header is always present.
    expect(r.config.headers!.some((h) => h.source === "/.mandu/client/(.*)")).toBe(true);
  });

  it("mixed runtime manifest emits a function entry per non-static route", () => {
    const r = compileVercelJson(baseManifest, baseCache, { projectName: "site" });
    expect(r.config.functions).toBeDefined();
    expect(r.config.functions!["app/api/embed/route.ts"]).toEqual({ runtime: "edge" });
    expect(r.config.functions!["app/page.tsx"]).toBeUndefined(); // static, no entry
    expect(r.perRoute).toHaveLength(2);
    expect(r.perRoute.find((x) => x.routeId === "index")?.runtime).toBe("static");
    expect(r.perRoute.find((x) => x.routeId === "api-embed")?.functionEntry).toBe(
      "app/api/embed/route.ts",
    );
  });

  it("cache directives become Cache-Control headers", () => {
    const r = compileVercelJson(baseManifest, baseCache, { projectName: "site" });
    const cacheForIndex = r.config.headers!.find((h) => h.source === "/");
    expect(cacheForIndex?.headers[0]!.value).toBe(
      "public, s-maxage=31536000, stale-while-revalidate=86400",
    );
  });

  it("regions + timeout map to vercel.json fields", () => {
    const cache: DeployIntentCache = {
      ...baseCache,
      intents: {
        ...baseCache.intents,
        "api-embed": edgeIntent({
          regions: ["icn1", "iad1"],
          timeout: 12_000,
        }),
      },
    };
    const r = compileVercelJson(baseManifest, cache, { projectName: "site" });
    const fn = r.config.functions!["app/api/embed/route.ts"]!;
    expect(fn.regions).toEqual(["icn1", "iad1"]);
    expect(fn.maxDuration).toBe(12);
  });

  it("overrides.vercel shallow-merges onto the function entry", () => {
    const cache: DeployIntentCache = {
      ...baseCache,
      intents: {
        ...baseCache.intents,
        "api-embed": edgeIntent({
          overrides: { vercel: { memory: 1024, customField: "x" } },
        }),
      },
    };
    const r = compileVercelJson(baseManifest, cache, { projectName: "site" });
    const fn = r.config.functions!["app/api/embed/route.ts"]!;
    expect(fn.memory).toBe(1024);
    expect(fn.customField).toBe("x");
    // Does not overwrite the runtime we computed.
    expect(fn.runtime).toBe("edge");
  });
});

describe("compileVercelJson — runtime-specific behaviour", () => {
  it("bun runtime emits @vercel/bun + warns about #248", () => {
    const cache: DeployIntentCache = {
      ...baseCache,
      intents: {
        ...baseCache.intents,
        "api-embed": {
          ...edgeIntent(),
          intent: {
            runtime: "bun",
            cache: "no-store",
            visibility: "public",
          },
          rationale: "uses bun:sqlite",
        },
      },
    };
    const r = compileVercelJson(baseManifest, cache, { projectName: "site" });
    expect(r.config.functions!["app/api/embed/route.ts"]!.runtime).toBe("@vercel/bun@1.0.0");
    expect(r.warnings.some((w) => w.includes("@vercel/bun"))).toBe(true);
  });

  it("node runtime omits the runtime field + warns about Bun-only startServer", () => {
    const cache: DeployIntentCache = {
      ...baseCache,
      intents: {
        ...baseCache.intents,
        "api-embed": {
          ...edgeIntent(),
          intent: {
            runtime: "node",
            cache: "no-store",
            visibility: "public",
          },
          rationale: "node",
        },
      },
    };
    const r = compileVercelJson(baseManifest, cache, { projectName: "site" });
    const fn = r.config.functions!["app/api/embed/route.ts"]!;
    expect(fn.runtime).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("Bun-only globals"))).toBe(true);
  });
});

describe("compileVercelJson — validation", () => {
  it("missing intent surfaces in the error message", () => {
    const cache: DeployIntentCache = {
      version: 1,
      generatedAt: "2026-04-30T00:00:00.000Z",
      brainModel: "heuristic",
      intents: { index: staticIntent() },
    };
    expect(() =>
      compileVercelJson(baseManifest, cache, { projectName: "site" }),
    ).toThrow(VercelCompileError);
  });

  it("rejects static intent on a dynamic page without staticParams", () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          id: "lang",
          pattern: "/:lang",
          module: "app/[lang]/page.tsx",
          kind: "page",
          componentModule: "app/[lang]/page.tsx",
        } as RouteSpec,
      ],
    };
    const cache: DeployIntentCache = {
      version: 1,
      generatedAt: "2026-04-30T00:00:00.000Z",
      brainModel: "heuristic",
      intents: { lang: staticIntent() },
    };
    expect(() =>
      compileVercelJson(manifest, cache, { projectName: "site" }),
    ).toThrow(/generateStaticParams/);
  });

  it("private visibility emits a warning", () => {
    const cache: DeployIntentCache = {
      ...baseCache,
      intents: {
        ...baseCache.intents,
        "api-embed": edgeIntent({ visibility: "private" }),
      },
    };
    const r = compileVercelJson(baseManifest, cache, { projectName: "site" });
    expect(r.warnings.some((w) => w.includes("private"))).toBe(true);
  });
});

describe("renderVercelJsonFromCompile", () => {
  it("emits stable JSON ending with newline", () => {
    const r = compileVercelJson(baseManifest, baseCache, { projectName: "site" });
    const out = renderVercelJsonFromCompile(r);
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual(r.config as unknown as Record<string, unknown>);
  });
});

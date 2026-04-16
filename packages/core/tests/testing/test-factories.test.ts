/**
 * Test Factory Helpers Tests
 *
 * Covers createTestManifest and createTestIsland from the testing module.
 */
import { describe, it, expect } from "bun:test";
import path from "path";
import {
  createTestManifest,
  createTestIsland,
  createMockMcpContext,
} from "../../src/testing/index";

// ---------------------------------------------------------------------------
// createTestManifest
// ---------------------------------------------------------------------------

describe("createTestManifest", () => {
  it("creates a manifest with version 1", () => {
    const manifest = createTestManifest([]);
    expect(manifest.version).toBe(1);
    expect(manifest.routes).toEqual([]);
  });

  it("fills in default id when not provided", () => {
    const manifest = createTestManifest([{ kind: "page", pattern: "/" }]);
    expect(manifest.routes[0].id).toBe("test-route-0");
  });

  it("fills in default kind as 'page' when not provided", () => {
    const manifest = createTestManifest([{ pattern: "/about" }]);
    expect(manifest.routes[0].kind).toBe("page");
  });

  it("fills in default pattern when not provided", () => {
    const manifest = createTestManifest([{ id: "home" }]);
    expect(manifest.routes[0].pattern).toBe("/test-0");
  });

  it("fills in default module path", () => {
    const manifest = createTestManifest([{ id: "home" }]);
    expect(manifest.routes[0].module).toBe("app/test-0/page.tsx");
  });

  it("preserves explicitly set fields", () => {
    const manifest = createTestManifest([
      {
        id: "my-page",
        kind: "page",
        pattern: "/custom",
        module: "app/custom/page.tsx",
        componentModule: "app/custom/page.tsx",
      },
    ]);

    const route = manifest.routes[0];
    expect(route.id).toBe("my-page");
    expect(route.kind).toBe("page");
    expect(route.pattern).toBe("/custom");
    expect(route.module).toBe("app/custom/page.tsx");
  });

  it("generates componentModule for page routes", () => {
    const manifest = createTestManifest([
      { id: "page1", kind: "page", pattern: "/" },
    ]);

    expect(manifest.routes[0].componentModule).toBeDefined();
  });

  it("does not generate componentModule for api routes", () => {
    const manifest = createTestManifest([
      { id: "api1", kind: "api", pattern: "/api/data" },
    ]);

    expect(manifest.routes[0].componentModule).toBeUndefined();
  });

  it("creates multiple routes with sequential defaults", () => {
    const manifest = createTestManifest([
      { kind: "page" },
      { kind: "api" },
      { kind: "page" },
    ]);

    expect(manifest.routes).toHaveLength(3);
    expect(manifest.routes[0].id).toBe("test-route-0");
    expect(manifest.routes[1].id).toBe("test-route-1");
    expect(manifest.routes[2].id).toBe("test-route-2");
    expect(manifest.routes[0].pattern).toBe("/test-0");
    expect(manifest.routes[1].pattern).toBe("/test-1");
    expect(manifest.routes[2].pattern).toBe("/test-2");
  });

  it("supports mixing explicit and default fields", () => {
    const manifest = createTestManifest([
      { id: "home", kind: "page", pattern: "/" },
      { kind: "api" },
    ]);

    expect(manifest.routes[0].id).toBe("home");
    expect(manifest.routes[0].pattern).toBe("/");
    expect(manifest.routes[1].id).toBe("test-route-1");
    expect(manifest.routes[1].kind).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// createTestIsland
// ---------------------------------------------------------------------------

describe("createTestIsland", () => {
  it("creates island descriptor with default 'visible' strategy", () => {
    const island = createTestIsland("counter");
    expect(island.__island).toBe(true);
    expect(island.__name).toBe("counter");
    expect(island.__hydrate).toBe("visible");
  });

  it("accepts custom hydration strategy", () => {
    const island = createTestIsland("modal", "interaction");
    expect(island.__hydrate).toBe("interaction");
    expect(island.__name).toBe("modal");
  });

  it("creates distinct instances for different names", () => {
    const island1 = createTestIsland("a");
    const island2 = createTestIsland("b");
    expect(island1.__name).not.toBe(island2.__name);
  });

  it("supports all standard strategies", () => {
    for (const strategy of ["visible", "idle", "interaction", "immediate"]) {
      const island = createTestIsland("test", strategy);
      expect(island.__hydrate).toBe(strategy);
      expect(island.__island).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// createMockMcpContext
// ---------------------------------------------------------------------------

describe("createMockMcpContext", () => {
  it("creates a context with default paths when no root is provided", () => {
    const ctx = createMockMcpContext();
    expect(ctx.paths.repoRoot).toBeDefined();
    expect(ctx.paths.manduDir).toBe(path.join(ctx.paths.repoRoot, ".mandu"));
    expect(ctx.paths.manifestPath).toBe(
      path.join(ctx.paths.repoRoot, ".mandu", "routes.manifest.json"),
    );
    expect(ctx.paths.specsDir).toBe(path.join(ctx.paths.repoRoot, "spec"));
    expect(ctx.paths.slotsDir).toBe(path.join(ctx.paths.repoRoot, "spec", "slots"));
  });

  it("uses the provided root directory", () => {
    const ctx = createMockMcpContext({ root: "/fake/project" });
    expect(ctx.paths.repoRoot).toBe("/fake/project");
    expect(ctx.paths.manduDir).toBe(path.join("/fake/project", ".mandu"));
  });

  it("returns the provided config from readConfig()", async () => {
    const config = { guard: { preset: "fsd" }, server: { port: 3333 } };
    const ctx = createMockMcpContext({ config });
    const result = await ctx.readConfig();
    expect(result).toEqual(config);
  });

  it("returns an empty config object by default", async () => {
    const ctx = createMockMcpContext();
    const result = await ctx.readConfig();
    expect(result).toEqual({});
  });

  it("returns the provided manifest from readManifest()", async () => {
    const manifest = createTestManifest([
      { id: "home", kind: "page", pattern: "/" },
    ]);
    const ctx = createMockMcpContext({ manifest });
    const result = await ctx.readManifest();
    expect(result).toBe(manifest);
    expect(result.routes).toHaveLength(1);
  });

  it("returns an empty manifest by default", async () => {
    const ctx = createMockMcpContext();
    const result = await ctx.readManifest();
    expect(result.version).toBe(1);
    expect(result.routes).toEqual([]);
  });

  it("readConfig and readManifest are async functions", () => {
    const ctx = createMockMcpContext();
    expect(ctx.readConfig()).toBeInstanceOf(Promise);
    expect(ctx.readManifest()).toBeInstanceOf(Promise);
  });
});

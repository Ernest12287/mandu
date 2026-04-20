import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateScenariosFromGraph, generateAndWriteScenarios } from "../src/scenario";
import { createEmptyGraph, addNode } from "../src/ir";
import { writeJson, readJson } from "../src/fs";
import type { InteractionGraph, OracleLevel, ScenarioBundle } from "../src/types";

describe("scenario", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "ate-scenario-test-"));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("should generate scenarios from simple graph", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/", file: "app/page.tsx", path: "/" });
    addNode(graph, {
      kind: "route",
      id: "/about",
      file: "app/about/page.tsx",
      path: "/about",
    });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.oracleLevel).toBe("L1");
    // 2 page routes: each produces route-smoke + ssr-verify = 4 total
    expect(bundle.scenarios).toHaveLength(4);

    const homeScenario = bundle.scenarios.find((s) => s.route === "/" && s.kind === "route-smoke");
    expect(homeScenario).toBeDefined();
    expect(homeScenario?.kind).toBe("route-smoke");
    expect(homeScenario?.id).toBe("route:/");
    expect(homeScenario?.oracleLevel).toBe("L1");

    const homeSsr = bundle.scenarios.find((s) => s.route === "/" && s.kind === "ssr-verify");
    expect(homeSsr).toBeDefined();
    expect(homeSsr?.id).toBe("/--ssr-verify");

    const aboutScenario = bundle.scenarios.find((s) => s.route === "/about" && s.kind === "route-smoke");
    expect(aboutScenario).toBeDefined();
    expect(aboutScenario?.id).toBe("route:/about");
  });

  test("should apply L0 oracle level", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/", file: "app/page.tsx", path: "/" });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L0");

    // Assert
    expect(bundle.oracleLevel).toBe("L0");
    expect(bundle.scenarios[0].oracleLevel).toBe("L0");
  });

  test("should apply L2 oracle level", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/dashboard", file: "app/dashboard/page.tsx", path: "/dashboard" });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L2");

    // Assert
    expect(bundle.oracleLevel).toBe("L2");
    expect(bundle.scenarios[0].oracleLevel).toBe("L2");
  });

  test("should apply L3 oracle level", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/admin", file: "app/admin/page.tsx", path: "/admin" });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L3");

    // Assert
    expect(bundle.oracleLevel).toBe("L3");
    expect(bundle.scenarios[0].oracleLevel).toBe("L3");
  });

  test("should handle empty graph", () => {
    // Setup
    const graph = createEmptyGraph("test");

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert
    expect(bundle.scenarios).toHaveLength(0);
    expect(bundle.oracleLevel).toBe("L1");
  });

  test("should only generate scenarios for route nodes", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/", file: "app/page.tsx", path: "/" });
    addNode(graph, { kind: "modal", id: "confirm", file: "modals/Confirm.tsx", name: "confirm" });
    addNode(graph, { kind: "action", id: "user.login", file: "actions/user.ts", name: "user.login" });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert - route node produces route-smoke + ssr-verify; modal/action nodes produce nothing
    expect(bundle.scenarios).toHaveLength(2);
    expect(bundle.scenarios[0].route).toBe("/");
    expect(bundle.scenarios[0].kind).toBe("route-smoke");
    expect(bundle.scenarios[1].kind).toBe("ssr-verify");
  });

  test("should generate correct scenario IDs", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/", file: "app/page.tsx", path: "/" });
    addNode(graph, { kind: "route", id: "/admin/users", file: "app/admin/users/page.tsx", path: "/admin/users" });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert - each page route gets route-smoke then ssr-verify
    const smokeIds = bundle.scenarios.filter(s => s.kind === "route-smoke").map(s => s.id);
    expect(smokeIds).toContain("route:/");
    expect(smokeIds).toContain("route:/admin/users");
  });

  test("should set generatedAt timestamp", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/", file: "app/page.tsx", path: "/" });

    const beforeTime = new Date().toISOString();

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    const afterTime = new Date().toISOString();

    // Assert
    expect(bundle.generatedAt).toBeDefined();
    expect(bundle.generatedAt >= beforeTime).toBe(true);
    expect(bundle.generatedAt <= afterTime).toBe(true);
  });

  test("generateAndWriteScenarios should write to correct path", () => {
    // Setup
    const repoRoot = join(testDir, "write-test");
    mkdirSync(repoRoot, { recursive: true });

    const graph = createEmptyGraph("test");
    addNode(graph, { kind: "route", id: "/", file: "app/page.tsx", path: "/" });

    const manduDir = join(repoRoot, ".mandu");
    mkdirSync(manduDir, { recursive: true });
    writeJson(join(manduDir, "interaction-graph.json"), graph);

    // Execute
    const result = generateAndWriteScenarios(repoRoot, "L1");

    // Assert - 1 page route produces route-smoke + ssr-verify = 2
    expect(result.count).toBe(2);
    expect(result.scenariosPath).toContain("scenarios");

    const writtenBundle: ScenarioBundle = readJson(result.scenariosPath);
    expect(writtenBundle.scenarios).toHaveLength(2);
    expect(writtenBundle.oracleLevel).toBe("L1");
  });

  test("should handle large number of routes", () => {
    // Setup
    const graph = createEmptyGraph("test");

    for (let i = 0; i < 100; i++) {
      addNode(graph, {
        kind: "route",
        id: `/route-${i}`,
        file: `app/route-${i}/page.tsx`,
        path: `/route-${i}`,
      });
    }

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert - 100 page routes: each gets route-smoke + ssr-verify = 200
    expect(bundle.scenarios).toHaveLength(200);
    const smokeScenarios = bundle.scenarios.filter(s => s.kind === "route-smoke");
    const ssrScenarios = bundle.scenarios.filter(s => s.kind === "ssr-verify");
    expect(smokeScenarios).toHaveLength(100);
    expect(ssrScenarios).toHaveLength(100);
  });

  test("should preserve route path in scenario", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, {
      kind: "route",
      id: "/products/[id]",
      file: "app/products/[id]/page.tsx",
      path: "/products/[id]",
    });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert
    expect(bundle.scenarios[0].route).toBe("/products/[id]");
  });

  test("redirect route: ssr-verify scenario carries isRedirect and island-hydration is skipped", () => {
    // Setup — redirect route with an island (e.g. locale picker island on the
    // root that redirects to /<defaultLocale>). No island-hydration scenario
    // should be produced: the origin page navigates away before hydration.
    const graph = createEmptyGraph("test");
    addNode(graph, {
      kind: "route",
      id: "/",
      file: "app/page.tsx",
      path: "/",
      hasIsland: true,
      isRedirect: true,
    });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert
    const ssr = bundle.scenarios.find((s) => s.kind === "ssr-verify");
    expect(ssr).toBeDefined();
    expect(ssr?.isRedirect).toBe(true);
    const islandHydration = bundle.scenarios.find((s) => s.kind === "island-hydration");
    expect(islandHydration).toBeUndefined();
  });

  test("non-redirect island route: ssr-verify has no isRedirect and island-hydration still emitted", () => {
    const graph = createEmptyGraph("test");
    addNode(graph, {
      kind: "route",
      id: "/dashboard",
      file: "app/dashboard/page.tsx",
      path: "/dashboard",
      hasIsland: true,
    });

    const bundle = generateScenariosFromGraph(graph, "L1");

    const ssr = bundle.scenarios.find((s) => s.kind === "ssr-verify");
    expect(ssr).toBeDefined();
    expect(ssr?.isRedirect).toBeUndefined();
    const islandHydration = bundle.scenarios.find((s) => s.kind === "island-hydration");
    expect(islandHydration).toBeDefined();
  });

  test("should handle routes with special characters", () => {
    // Setup
    const graph = createEmptyGraph("test");
    addNode(graph, {
      kind: "route",
      id: "/api/v1/users",
      file: "app/api/v1/users/page.tsx",
      path: "/api/v1/users",
    });

    // Execute
    const bundle = generateScenariosFromGraph(graph, "L1");

    // Assert
    expect(bundle.scenarios[0].id).toBe("api:/api/v1/users");
    expect(bundle.scenarios[0].kind).toBe("api-smoke");
    expect(bundle.scenarios[0].route).toBe("/api/v1/users");
  });
});

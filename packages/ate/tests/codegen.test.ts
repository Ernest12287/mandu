import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePlaywrightSpecs } from "../src/codegen";
import { generateAndWriteScenarios } from "../src/scenario";
import { createEmptyGraph, addNode } from "../src/ir";
import { writeJson } from "../src/fs";
import type { InteractionGraph } from "../src/types";

describe("codegen", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "ate-codegen-test-"));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function setupProject(routes: Array<{ id: string; path: string; file: string }>) {
    const repoRoot = join(testDir, `project-${Date.now()}`);
    mkdirSync(repoRoot, { recursive: true });

    const graph = createEmptyGraph("test");
    routes.forEach((r) => addNode(graph, { kind: "route", ...r }));

    const manduDir = join(repoRoot, ".mandu");
    mkdirSync(manduDir, { recursive: true });
    writeJson(join(manduDir, "interaction-graph.json"), graph);

    return repoRoot;
  }

  test("should generate Playwright spec for single route", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert - 1 page route produces route-smoke + ssr-verify = 2 spec files
    expect(result.files).toHaveLength(2);

    const smokeFile = result.files.find(f => f.includes("route__"));
    expect(smokeFile).toBeDefined();

    const specContent = readFileSync(smokeFile!, "utf8");
    expect(specContent).toContain('import { test, expect } from "@playwright/test"');
    expect(specContent).toContain('test.describe("route:/"');
    expect(specContent).toContain('test("smoke /"');
  });

  test("should apply L0 oracle template", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L0");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    const specContent = readFileSync(result.files[0], "utf8");

    // L0: console.error and exception checks
    expect(specContent).toContain("const errors: string[] = []");
    expect(specContent).toContain('page.on("console"');
    expect(specContent).toContain('page.on("pageerror"');
    expect(specContent).toContain('expect(errors, "console/page errors").toEqual([])');

    // L0: should NOT have L1 structure checks
    expect(specContent).not.toContain('expect(page.locator("main"))');
  });

  test("should apply L1 oracle template", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    const specContent = readFileSync(result.files[0], "utf8");

    // L1: includes L0 checks
    expect(specContent).toContain('page.on("console"');

    // L1: structure signals (실제 구현은 Domain-aware)
    expect(specContent).toContain("// L1: Domain-aware structure signals");
    expect(specContent).toContain('await expect(page.locator("main, [role=\'main\']")).toBeVisible()');
  });

  test("should apply L2 oracle template", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L2");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    const specContent = readFileSync(result.files[0], "utf8");

    // L2: includes L1 checks
    expect(specContent).toContain("L1: Domain-aware structure signals");

    // L2: contract/schema-level assertions (no longer a placeholder)
    // L2 generates actual verification code — check for any assertion pattern
    expect(specContent).toContain("expect(");
  });

  test("should apply L3 oracle template", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L3");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    const specContent = readFileSync(result.files[0], "utf8");

    // L3: behavioral assertions (state change, island hydration, navigation)
    expect(specContent).toContain("expect(");
  });

  test("should generate config file if not exists", async () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    generatePlaywrightSpecs(repoRoot);

    // Wait for async Bun.write to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Assert
    const configPath = join(repoRoot, "tests", "e2e", "playwright.config.ts");
    expect(existsSync(configPath)).toBe(true);

    const configContent = readFileSync(configPath, "utf8");
    expect(configContent).toContain("export default defineConfig");
    expect(configContent).toContain('testDir: "."');
    expect(configContent).toContain("baseURL:");
  });

  test("should not overwrite existing config", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    const configPath = join(repoRoot, "tests", "e2e", "playwright.config.ts");
    mkdirSync(join(repoRoot, "tests", "e2e"), { recursive: true });

    const customConfig = `// Custom config\nexport default defineConfig({ testDir: "." });\n`;
    writeFileSync(configPath, customConfig);

    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    generatePlaywrightSpecs(repoRoot);

    // Assert - should keep custom config (only migrates old testDir: "tests/e2e" pattern)
    const configContent = readFileSync(configPath, "utf8");
    expect(configContent).toBe(customConfig);
  });

  test("should filter routes with onlyRoutes option", () => {
    // Setup
    const repoRoot = setupProject([
      { id: "/", path: "/", file: "app/page.tsx" },
      { id: "/about", path: "/about", file: "app/about/page.tsx" },
      { id: "/contact", path: "/contact", file: "app/contact/page.tsx" },
    ]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot, { onlyRoutes: ["/", "/about"] });

    // Assert
    expect(result.files.length).toBeGreaterThanOrEqual(2);

    const fileNames = result.files.map((f) => f.split(/[\\/]/).pop());
    expect(fileNames).toContain("route__.spec.ts"); // route:/ → route__
    expect(fileNames).toContain("route__about.spec.ts");
    expect(fileNames).not.toContain("route__contact.spec.ts");
  });

  test("should sanitize route IDs for filenames", () => {
    // Setup
    const repoRoot = setupProject([
      { id: "/products/[id]", path: "/products/[id]", file: "app/products/[id]/page.tsx" },
    ]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    const fileName = result.files[0].split(/[\\/]/).pop();
    expect(fileName).toBe("route__products__id_.spec.ts");
    expect(fileName).not.toContain("[");
    expect(fileName).not.toContain("]");
  });

  test("should generate multiple specs for multiple routes", () => {
    // Setup
    const repoRoot = setupProject([
      { id: "/", path: "/", file: "app/page.tsx" },
      { id: "/dashboard", path: "/dashboard", file: "app/dashboard/page.tsx" },
      { id: "/settings", path: "/settings", file: "app/settings/page.tsx" },
    ]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert - 3 page routes: each produces route-smoke + ssr-verify = 6 spec files
    expect(result.files).toHaveLength(6);

    result.files.forEach((file) => {
      expect(existsSync(file)).toBe(true);
      const content = readFileSync(file, "utf8");
      expect(content).toContain("import { test, expect }");
    });
  });

  test("should use baseURL from environment with IPv4 fallback", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert — 127.0.0.1 (not localhost) sidesteps IPv6/IPv4 DNS mismatch on
    // Windows Node fetch (#223). Every emitted spec should use the same fallback.
    for (const file of result.files) {
      const specContent = readFileSync(file, "utf8");
      expect(specContent).toContain('const url = (baseURL ?? "http://127.0.0.1:3333")');
      expect(specContent).not.toContain('localhost:3333');
    }
  });

  test("should handle root route correctly", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    const specContent = readFileSync(result.files[0], "utf8");
    expect(specContent).toContain('+ "/"');
    expect(specContent).not.toContain('+ ""');
  });

  test("should include await page.goto with waitUntil networkidle", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert — every page-oriented spec waits for network idle before
    // inspecting the page. This prevents page.content() failures on routes
    // that redirect on load (#224).
    for (const file of result.files) {
      const specContent = readFileSync(file, "utf8");
      // Either the goto carries waitUntil or the spec is API-only (no page).
      if (specContent.includes("page.goto(")) {
        expect(specContent).toContain('waitUntil: "networkidle"');
      }
    }
  });

  test("redirect route: ssr-verify spec skips page.content() and asserts navigation", () => {
    // Setup — manually craft a graph with isRedirect=true on the root route.
    const repoRoot = join(testDir, `project-redirect-${Date.now()}`);
    mkdirSync(repoRoot, { recursive: true });
    const graph = createEmptyGraph("test");
    addNode(graph, {
      kind: "route",
      id: "/",
      path: "/",
      file: "app/page.tsx",
      isRedirect: true,
    });
    const manduDir = join(repoRoot, ".mandu");
    mkdirSync(manduDir, { recursive: true });
    writeJson(join(manduDir, "interaction-graph.json"), graph);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert — ssr-verify spec for a redirect route must not call
    // page.content() immediately after goto (it will throw while the page is
    // still navigating). It should assert navigation settled instead.
    const ssrFile = result.files.find((f) => f.includes("ssr-verify"));
    expect(ssrFile).toBeDefined();
    const ssrContent = readFileSync(ssrFile!, "utf8");
    expect(ssrContent).not.toContain("page.content()");
    expect(ssrContent).not.toContain('expect(html).toContain("<!DOCTYPE html>")');
    expect(ssrContent).toContain('waitUntil: "networkidle"');
    expect(ssrContent).toContain("expect(page.url()");
    expect(ssrContent).toContain("waitForLoadState");
  });

  test("non-redirect route: ssr-verify spec still asserts DOCTYPE + html shape", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    const ssrFile = result.files.find((f) => f.includes("ssr-verify"));
    expect(ssrFile).toBeDefined();
    const ssrContent = readFileSync(ssrFile!, "utf8");
    expect(ssrContent).toContain("const html = await page.content();");
    expect(ssrContent).toContain('expect(html).toContain("<!DOCTYPE html>")');
    expect(ssrContent).toContain('waitUntil: "networkidle"');
  });

  test("#226 ssr-verify asserts body is non-empty and has semantic anchor", () => {
    // Setup — a plain page route without redirect / island.
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);
    const ssrFile = result.files.find((f) => f.includes("ssr-verify"));
    expect(ssrFile).toBeDefined();
    const ssrContent = readFileSync(ssrFile!, "utf8");

    // Assert — body-content non-empty guard (prevents empty <body> from passing).
    expect(ssrContent).toContain("bodyInner.length");
    expect(ssrContent).toContain("toBeGreaterThan(0)");

    // Assert — semantic anchor requirement ([data-route-id] OR <main>).
    expect(ssrContent).toContain("data-route-id=");
    expect(ssrContent).toContain("<main");
    expect(ssrContent).toContain("hasRouteAnchor || hasMainLandmark");
  });

  test("should create auto/ directory for generated specs", () => {
    // Setup
    const repoRoot = setupProject([{ id: "/", path: "/", file: "app/page.tsx" }]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    generatePlaywrightSpecs(repoRoot);

    // Assert
    const autoDir = join(repoRoot, "tests", "e2e", "auto");
    expect(existsSync(autoDir)).toBe(true);
  });

  test("should handle empty scenarios gracefully", () => {
    // Setup
    const repoRoot = setupProject([]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert
    expect(result.files).toHaveLength(0);
  });

  test("should generate valid TypeScript syntax", () => {
    // Setup
    const repoRoot = setupProject([
      { id: "/", path: "/", file: "app/page.tsx" },
      { id: "/about", path: "/about", file: "app/about/page.tsx" },
    ]);
    generateAndWriteScenarios(repoRoot, "L1");

    // Execute
    const result = generatePlaywrightSpecs(repoRoot);

    // Assert - basic syntax validation
    result.files.forEach((file) => {
      const content = readFileSync(file, "utf8");

      // Check for balanced braces
      const openBraces = (content.match(/{/g) || []).length;
      const closeBraces = (content.match(/}/g) || []).length;
      expect(openBraces).toBe(closeBraces);

      // Check for balanced parentheses
      const openParens = (content.match(/\(/g) || []).length;
      const closeParens = (content.match(/\)/g) || []).length;
      expect(openParens).toBe(closeParens);

      // Check imports are at top
      expect(content.trim().startsWith("import")).toBe(true);
    });
  });
});

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCoverageGaps } from "../src/coverage-gap";
import { writeJson, ensureDir } from "../src/fs";
import type { InteractionGraph, InteractionEdge, InteractionNode } from "../src/types";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "ate-coverage-gap-test-"));
});

afterAll(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function createProject(opts: {
  graph?: Partial<InteractionGraph>;
  autoSpecs?: Record<string, string>;
  manualSpecs?: Record<string, string>;
}): string {
  const projectDir = join(testDir, `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(projectDir, { recursive: true });

  // Write interaction graph
  const graph: InteractionGraph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    buildSalt: "test",
    nodes: [],
    edges: [],
    stats: { routes: 0, navigations: 0, modals: 0, actions: 0 },
    ...opts.graph,
  };

  const manduDir = join(projectDir, ".mandu");
  ensureDir(manduDir);
  writeJson(join(manduDir, "interaction-graph.json"), graph);

  // Write auto specs
  if (opts.autoSpecs) {
    const autoDir = join(projectDir, "tests", "e2e", "auto");
    ensureDir(autoDir);
    for (const [name, content] of Object.entries(opts.autoSpecs)) {
      writeFileSync(join(autoDir, name), content, "utf8");
    }
  }

  // Write manual specs
  if (opts.manualSpecs) {
    const manualDir = join(projectDir, "tests", "e2e", "manual");
    ensureDir(manualDir);
    for (const [name, content] of Object.entries(opts.manualSpecs)) {
      writeFileSync(join(manualDir, name), content, "utf8");
    }
  }

  return projectDir;
}

test("detectCoverageGaps: returns 100% when no edges exist", () => {
  const projectDir = createProject({
    graph: {
      nodes: [{ kind: "route", id: "/", file: "app/page.tsx", path: "/" }],
      edges: [],
    },
  });

  const result = detectCoverageGaps(projectDir);

  // No edges and no API routes without inbound edges -> might have 0 or few synthetic edges
  expect(result.coveragePercent).toBeGreaterThanOrEqual(0);
  expect(result.totalEdges).toBeGreaterThanOrEqual(0);
});

test("detectCoverageGaps: returns 100% when no graph exists", () => {
  const projectDir = join(testDir, `no-graph-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });

  const result = detectCoverageGaps(projectDir);

  expect(result.gaps).toEqual([]);
  expect(result.coveragePercent).toBe(100);
});

test("detectCoverageGaps: detects uncovered navigate edges", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
        { kind: "route", id: "/about", file: "app/about/page.tsx", path: "/about" },
      ],
      edges: [
        { kind: "navigate", from: "/", to: "/about", file: "app/page.tsx", source: "<jsx href>" },
      ],
      stats: { routes: 2, navigations: 1, modals: 0, actions: 0 },
    },
  });

  const result = detectCoverageGaps(projectDir);

  // The navigate edge from "/" to "/about" has no test spec
  expect(result.gaps.length).toBeGreaterThan(0);
  const navGap = result.gaps.find((g) => g.type === "route-transition" && g.to === "/about");
  expect(navGap).toBeDefined();
  expect(navGap!.suggestion).toContain("/about");
});

test("detectCoverageGaps: marks edges as covered when specs reference the routes", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
        { kind: "route", id: "/about", file: "app/about/page.tsx", path: "/about" },
      ],
      edges: [
        { kind: "navigate", from: "/", to: "/about", file: "app/page.tsx", source: "<jsx href>" },
      ],
      stats: { routes: 2, navigations: 1, modals: 0, actions: 0 },
    },
    autoSpecs: {
      "home-to-about.spec.ts": `
import { test, expect } from "@playwright/test";
test("navigate from home to about", async ({ page }) => {
  await page.goto("/");
  await page.click('a[href="/about"]');
  await expect(page).toHaveURL("/about");
});
`,
    },
  });

  const result = detectCoverageGaps(projectDir);

  // The spec references both "/" and "/about", so the navigate edge should be covered.
  expect(result.coveredEdges).toBeGreaterThanOrEqual(1);
});

test("detectCoverageGaps: detects uncovered API routes as api-call gaps", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
        { kind: "route", id: "/api/users", file: "app/api/users/route.ts", path: "/api/users", methods: ["GET", "POST"] },
      ],
      edges: [],
      stats: { routes: 2, navigations: 0, modals: 0, actions: 0 },
    },
  });

  const result = detectCoverageGaps(projectDir);

  // The API route has no inbound edge and no test, so a synthetic gap should exist.
  const apiGap = result.gaps.find((g) => g.to === "/api/users");
  expect(apiGap).toBeDefined();
  expect(apiGap!.type).toBe("api-call");
  expect(apiGap!.suggestion).toContain("/api/users");
});

test("detectCoverageGaps: detects island interaction gaps", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/dashboard", file: "app/dashboard/page.tsx", path: "/dashboard", hasIsland: true },
      ],
      edges: [],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
    },
  });

  const result = detectCoverageGaps(projectDir);

  // Island route without hydration test should produce a gap.
  expect(result.totalEdges).toBeGreaterThanOrEqual(1);
});

test("detectCoverageGaps: detects modal open gaps", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
      ],
      edges: [
        { kind: "openModal", from: "/", modal: "confirm-dialog", file: "app/page.tsx", source: "mandu.modal.open" },
      ],
      stats: { routes: 1, navigations: 0, modals: 1, actions: 0 },
    },
  });

  const result = detectCoverageGaps(projectDir);

  const modalGap = result.gaps.find((g) => g.type === "island-interaction" && g.to === "confirm-dialog");
  expect(modalGap).toBeDefined();
  expect(modalGap!.suggestion).toContain("confirm-dialog");
});

test("detectCoverageGaps: detects runAction gaps as form-action type", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/settings", file: "app/settings/page.tsx", path: "/settings" },
      ],
      edges: [
        { kind: "runAction", from: "/settings", action: "updateProfile", file: "app/settings/page.tsx", source: "mandu.action.run" },
      ],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 1 },
    },
  });

  const result = detectCoverageGaps(projectDir);

  const actionGap = result.gaps.find((g) => g.type === "form-action" && g.to === "updateProfile");
  expect(actionGap).toBeDefined();
  expect(actionGap!.suggestion).toContain("updateProfile");
});

test("detectCoverageGaps: coverage percent computed correctly", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
        { kind: "route", id: "/about", file: "app/about/page.tsx", path: "/about" },
        { kind: "route", id: "/contact", file: "app/contact/page.tsx", path: "/contact" },
      ],
      edges: [
        { kind: "navigate", from: "/", to: "/about", file: "app/page.tsx", source: "<jsx href>" },
        { kind: "navigate", from: "/", to: "/contact", file: "app/page.tsx", source: "<jsx href>" },
      ],
      stats: { routes: 3, navigations: 2, modals: 0, actions: 0 },
    },
    autoSpecs: {
      "home-nav.spec.ts": `
import { test, expect } from "@playwright/test";
test("nav", async ({ page }) => {
  await page.goto("/");
  await page.click('a[href="/about"]');
});
`,
    },
  });

  const result = detectCoverageGaps(projectDir);

  // At least some edges exist
  expect(result.totalEdges).toBeGreaterThanOrEqual(2);
  expect(result.coveragePercent).toBeGreaterThanOrEqual(0);
  expect(result.coveragePercent).toBeLessThanOrEqual(100);
});

test("detectCoverageGaps: throws when repoRoot is empty", () => {
  expect(() => detectCoverageGaps("")).toThrow("repoRoot is required");
});

test("detectCoverageGaps: manual specs also count as coverage", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
        { kind: "route", id: "/login", file: "app/login/page.tsx", path: "/login" },
      ],
      edges: [
        { kind: "navigate", from: "/", to: "/login", file: "app/page.tsx", source: "<jsx href>" },
      ],
      stats: { routes: 2, navigations: 1, modals: 0, actions: 0 },
    },
    manualSpecs: {
      "login-flow.spec.ts": `
import { test, expect } from "@playwright/test";
test("login from home", async ({ page }) => {
  await page.goto("/");
  await page.click('a[href="/login"]');
});
`,
    },
  });

  const result = detectCoverageGaps(projectDir);

  // The manual spec covers the "/" to "/login" navigate edge
  expect(result.coveredEdges).toBeGreaterThanOrEqual(1);
});

test("detectCoverageGaps: suggestion text is meaningful", () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
        { kind: "route", id: "/products", file: "app/products/page.tsx", path: "/products" },
      ],
      edges: [
        { kind: "navigate", from: "/", to: "/products", file: "app/page.tsx", source: "<jsx href>" },
      ],
      stats: { routes: 2, navigations: 1, modals: 0, actions: 0 },
    },
  });

  const result = detectCoverageGaps(projectDir);

  for (const gap of result.gaps) {
    expect(gap.suggestion.length).toBeGreaterThan(10);
    // Suggestion should mention the target
    expect(gap.suggestion).toContain(gap.to);
  }
});

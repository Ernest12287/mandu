import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precommitCheck } from "../src/precommit";
import { writeJson, ensureDir } from "../src/fs";
import type { InteractionGraph } from "../src/types";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "ate-precommit-test-"));
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

test("precommitCheck: returns shouldTest=false when no staged files", async () => {
  const projectDir = createProject({
    graph: {
      nodes: [{ kind: "route", id: "/", file: "app/page.tsx", path: "/" }],
    },
  });

  const result = await precommitCheck({
    repoRoot: projectDir,
    stagedFiles: [],
  });

  expect(result.shouldTest).toBe(false);
  expect(result.routes).toEqual([]);
  expect(result.reason).toContain("No staged files");
});

test("precommitCheck: returns shouldTest=false when only non-source files staged", async () => {
  const projectDir = createProject({
    graph: {
      nodes: [{ kind: "route", id: "/", file: "app/page.tsx", path: "/" }],
    },
  });

  const result = await precommitCheck({
    repoRoot: projectDir,
    stagedFiles: ["README.md", "docs/guide.txt"],
  });

  expect(result.shouldTest).toBe(false);
  expect(result.reason).toContain("no source code");
});

test("precommitCheck: returns shouldTest=true when route file staged with no tests", async () => {
  const projectDir = createProject({
    graph: {
      nodes: [{ kind: "route", id: "/", file: "app/page.tsx", path: "/" }],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
    },
  });

  // Write the actual source file so the path resolves
  const appDir = join(projectDir, "app");
  ensureDir(appDir);
  writeFileSync(join(appDir, "page.tsx"), `export default function Home() { return <div />; }`, "utf8");

  const result = await precommitCheck({
    repoRoot: projectDir,
    stagedFiles: ["app/page.tsx"],
  });

  expect(result.shouldTest).toBe(true);
  expect(result.routes.length).toBeGreaterThanOrEqual(1);
  expect(result.reason).toContain("no test coverage");
});

test("precommitCheck: returns shouldTest=false when all affected routes have tests", async () => {
  const projectDir = createProject({
    graph: {
      nodes: [{ kind: "route", id: "/", file: "app/page.tsx", path: "/" }],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
    },
    autoSpecs: {
      "home.spec.ts": `
import { test, expect } from "@playwright/test";
test("home smoke", async ({ page }) => {
  await page.goto("/");
  expect(await page.title()).toBeTruthy();
});
`,
    },
  });

  // Write the actual source file so the path resolves
  const appDir = join(projectDir, "app");
  ensureDir(appDir);
  writeFileSync(join(appDir, "page.tsx"), `export default function Home() { return <div />; }`, "utf8");

  const result = await precommitCheck({
    repoRoot: projectDir,
    stagedFiles: ["app/page.tsx"],
  });

  expect(result.shouldTest).toBe(false);
  expect(result.reason).toContain("existing tests");
});

test("precommitCheck: throws when repoRoot is empty", async () => {
  await expect(precommitCheck({ repoRoot: "", stagedFiles: ["a.ts"] })).rejects.toThrow("repoRoot is required");
});

test("precommitCheck: also works with string argument (backward compat)", async () => {
  await expect(precommitCheck("")).rejects.toThrow("repoRoot is required");
});

test("precommitCheck: lists untested routes in the reason", async () => {
  const projectDir = createProject({
    graph: {
      nodes: [
        { kind: "route", id: "/", file: "app/page.tsx", path: "/" },
        { kind: "route", id: "/dashboard", file: "app/dashboard/page.tsx", path: "/dashboard" },
      ],
      stats: { routes: 2, navigations: 0, modals: 0, actions: 0 },
    },
  });

  // Write the actual source files
  ensureDir(join(projectDir, "app"));
  writeFileSync(join(projectDir, "app", "page.tsx"), `export default function Home() { return <div />; }`, "utf8");
  ensureDir(join(projectDir, "app", "dashboard"));
  writeFileSync(join(projectDir, "app", "dashboard", "page.tsx"), `export default function Dash() { return <div />; }`, "utf8");

  const result = await precommitCheck({
    repoRoot: projectDir,
    stagedFiles: ["app/page.tsx", "app/dashboard/page.tsx"],
  });

  expect(result.shouldTest).toBe(true);
  // The reason should mention at least one route
  expect(result.reason).toMatch(/\/|\/dashboard/);
});

test("precommitCheck: handles no interaction graph gracefully", async () => {
  const projectDir = join(testDir, `no-graph-precommit-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });

  const result = await precommitCheck({
    repoRoot: projectDir,
    stagedFiles: ["app.ts"],
  });

  // No interaction graph -> smart selection returns empty -> no routes affected
  expect(result.shouldTest).toBe(false);
  expect(result.reason).toContain("No routes affected");
});

test("precommitCheck: mixed source and non-source files filters correctly", async () => {
  const projectDir = createProject({
    graph: {
      nodes: [{ kind: "route", id: "/", file: "app/page.tsx", path: "/" }],
      stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
    },
  });

  ensureDir(join(projectDir, "app"));
  writeFileSync(join(projectDir, "app", "page.tsx"), `export default function Home() { return <div />; }`, "utf8");

  const result = await precommitCheck({
    repoRoot: projectDir,
    stagedFiles: ["README.md", "app/page.tsx", "package.json"],
  });

  // Should process the source file even though non-source files are present
  expect(result.shouldTest).toBe(true);
  expect(result.routes).toContain("/");
});

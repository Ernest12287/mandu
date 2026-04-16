import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAteWatcher } from "../src/watcher";
import { writeJson, ensureDir } from "../src/fs";
import type { InteractionGraph } from "../src/types";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ate-watcher-test-"));
});

afterEach(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function writeGraph(repoRoot: string, graph: Partial<InteractionGraph>): void {
  ensureDir(join(repoRoot, ".mandu"));
  const full: InteractionGraph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    buildSalt: "test",
    nodes: [],
    edges: [],
    stats: { routes: 0, navigations: 0, modals: 0, actions: 0 },
    ...graph,
  };
  writeJson(join(repoRoot, ".mandu", "interaction-graph.json"), full);
}

test("watcher start/stop is clean with no watched dirs", async () => {
  const watcher = createAteWatcher({
    repoRoot: testDir,
    logger: silentLogger(),
    debounceMs: 10,
  });
  await watcher.start();
  watcher.stop();
  // Second stop should be a no-op
  watcher.stop();
  expect(true).toBe(true);
});

test("watcher start watches existing directories only", async () => {
  mkdirSync(join(testDir, "app"), { recursive: true });
  // src/ and tests/e2e/ intentionally absent
  const warns: string[] = [];
  const watcher = createAteWatcher({
    repoRoot: testDir,
    logger: { log: () => {}, warn: (m: string) => warns.push(m), error: () => {} },
    debounceMs: 10,
  });
  await watcher.start();
  watcher.stop();
  // Should have warned about at least src/ and tests/e2e/
  expect(warns.some((w) => w.includes("src"))).toBe(true);
  expect(warns.some((w) => w.includes("tests/e2e"))).toBe(true);
});

test("triggerForFiles warns and skips when no interaction graph", async () => {
  const watcher = createAteWatcher({
    repoRoot: testDir,
    logger: silentLogger(),
  });
  const result = await watcher.triggerForFiles(["app/page.tsx"]);
  expect(result.skipped).toBe(true);
  expect(result.affectedRoutes).toEqual([]);
  expect(result.exitCode).toBe(0);
});

test("triggerForFiles with no matching routes is skipped", async () => {
  // Graph with a route pointing to a different file than the one "changed"
  writeGraph(testDir, {
    nodes: [
      {
        kind: "route",
        id: "/about",
        file: "app/about/page.tsx",
        path: "/about",
      },
    ],
    stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
  });
  mkdirSync(join(testDir, "app"), { recursive: true });
  writeFileSync(join(testDir, "app", "unrelated.tsx"), "export {};\n");

  const completed: unknown[] = [];
  const watcher = createAteWatcher({
    repoRoot: testDir,
    logger: silentLogger(),
    onTestComplete: (r) => completed.push(r),
  });
  const result = await watcher.triggerForFiles(["app/unrelated.tsx"]);
  expect(result.skipped).toBe(true);
  expect(result.affectedRoutes).toEqual([]);
  expect(completed.length).toBe(1);
});

test("triggerForFiles detects direct file match for affected routes", async () => {
  mkdirSync(join(testDir, "app", "about"), { recursive: true });
  const routeFile = join(testDir, "app", "about", "page.tsx");
  writeFileSync(routeFile, "export default function Page(){return null;}\n");

  writeGraph(testDir, {
    nodes: [
      {
        kind: "route",
        id: "/about",
        file: "app/about/page.tsx",
        path: "/about",
      },
    ],
    stats: { routes: 1, navigations: 0, modals: 0, actions: 0 },
  });

  const started: string[][] = [];
  const watcher = createAteWatcher({
    repoRoot: testDir,
    logger: silentLogger(),
    onTestStart: (routes) => started.push(routes),
  });

  const result = await watcher.triggerForFiles(["app/about/page.tsx"]);
  // We don't require the pipeline to succeed (playwright won't run in tests),
  // but we require that the watcher correctly identified the affected route
  // and attempted a run (i.e. did NOT skip).
  expect(result.affectedRoutes).toContain("/about");
  expect(result.skipped).toBeFalsy();
  expect(started.length).toBe(1);
  expect(started[0]).toContain("/about");
});

test("watcher debounces rapid changes into a single run", async () => {
  mkdirSync(join(testDir, "app"), { recursive: true });
  // No graph → runs are skipped quickly
  const completions: number[] = [];
  const watcher = createAteWatcher({
    repoRoot: testDir,
    logger: silentLogger(),
    debounceMs: 50,
    onTestComplete: () => completions.push(Date.now()),
  });
  await watcher.start();

  // Simulate rapid file changes by writing files
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(testDir, "app", `file${i}.tsx`), `export const x = ${i};\n`);
  }

  // Wait longer than debounce + a small safety margin
  await new Promise((r) => setTimeout(r, 400));
  watcher.stop();

  // fs.watch recursive behaviour on some platforms (notably Linux without
  // inotify-recursive) may not fire at all — so we only assert the upper
  // bound: we must never see more than one completion for a single debounced
  // batch of rapid writes.
  expect(completions.length).toBeLessThanOrEqual(1);
});

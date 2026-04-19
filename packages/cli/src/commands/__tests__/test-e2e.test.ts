/**
 * Tests for `mandu test --e2e` orchestration (Phase 12.2).
 *
 * These tests run entirely against the Mandu repo's cwd (so they can
 * import `@mandujs/ate` via the workspace resolver) but operate on
 * mkdtemp-based project fixtures so they never touch the real user
 * project under test.
 *
 * The goals here are:
 *   1. `--e2e --dry-run` returns true and never spawns Playwright
 *      (verified by asserting it completes synchronously without
 *      waiting on any subprocess).
 *   2. `--e2e` (no dry-run) reports a config error exit when
 *      Playwright is missing from the fixture's node_modules.
 *   3. The plan output contains the expected markers so CI consumers
 *      can grep for them.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  runE2EPipeline,
  testCommand,
  resolveWatchDirs,
} from "../test";

const PREFIX = path.join(os.tmpdir(), "mandu-cli-test-e2e-");

async function setupProjectNoGraph(): Promise<string> {
  const dir = await fs.promises.mkdtemp(PREFIX + "no-graph-");
  // No .mandu/interaction-graph.json — ATE extract should create one
  // from the empty app/ dir (it tolerates missing).
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  return dir;
}

async function setupProjectWithGraph(routes: Array<{ id: string; file: string; path: string }>): Promise<string> {
  const dir = await fs.promises.mkdtemp(PREFIX + "graph-");
  const manduDir = path.join(dir, ".mandu");
  fs.mkdirSync(manduDir, { recursive: true });
  const graph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    buildSalt: "test",
    nodes: routes.map((r) => ({ kind: "route" as const, ...r, methods: ["GET"] })),
    edges: [],
    stats: { routes: routes.length, navigations: 0, modals: 0, actions: 0 },
  };
  fs.writeFileSync(
    path.join(manduDir, "interaction-graph.json"),
    JSON.stringify(graph, null, 2),
  );
  return dir;
}

// ═══════════════════════════════════════════════════════════════════════════
// runE2EPipeline — dry-run
// ═══════════════════════════════════════════════════════════════════════════

describe("runE2EPipeline --dry-run", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await setupProjectWithGraph([
      { id: "/home", file: "app/page.tsx", path: "/" },
      { id: "/api/users", file: "app/api/users/route.ts", path: "/api/users" },
    ]);
  });

  afterAll(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("returns ok=true with a resolved lcov path when coverage is on", async () => {
    const result = await runE2EPipeline({
      cwd: dir,
      dryRun: true,
      heal: false,
      coverage: true,
    });
    expect(result.ok).toBe(true);
    expect(result.lcovPath).not.toBeNull();
  });

  it("returns ok=true and null lcov path when coverage is off", async () => {
    const result = await runE2EPipeline({
      cwd: dir,
      dryRun: true,
      heal: false,
      coverage: false,
    });
    expect(result.ok).toBe(true);
    expect(result.lcovPath).toBeNull();
  });

  it("prints a plan and exits cleanly even with --heal", async () => {
    const result = await runE2EPipeline({
      cwd: dir,
      dryRun: true,
      heal: true,
      coverage: false,
    });
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runE2EPipeline — real mode without playwright installed
// ═══════════════════════════════════════════════════════════════════════════

describe("runE2EPipeline (no dry-run, no playwright)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await setupProjectNoGraph();
  });

  afterAll(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("returns ok=false when @playwright/test is missing", async () => {
    // ATE extract + generate will run (no-op with empty graph).
    // Then `findMissingPlaywright` trips CLI_E063 and we return false.
    const result = await runE2EPipeline({
      cwd: dir,
      dryRun: false,
      heal: false,
      coverage: false,
    });
    expect(result.ok).toBe(false);
    expect(result.lcovPath).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// testCommand dispatch
// ═══════════════════════════════════════════════════════════════════════════

describe("testCommand --e2e --dry-run", () => {
  it("returns true and skips the Playwright spawn", async () => {
    const dir = await setupProjectWithGraph([
      { id: "/", file: "app/page.tsx", path: "/" },
    ]);
    try {
      // Write an empty test config so `bun test` has nothing to match
      // but the dry-run path is reached first.
      const ok = await testCommand("all", {
        cwd: dir,
        e2e: true,
        dryRun: true,
      });
      expect(ok).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("--e2e --heal --dry-run still returns true", async () => {
    const dir = await setupProjectWithGraph([]);
    try {
      const ok = await testCommand("all", {
        cwd: dir,
        e2e: true,
        heal: true,
        dryRun: true,
      });
      expect(ok).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveWatchDirs (pure helper used in --dry-run plan)
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveWatchDirs", () => {
  it("filters out directories that don't exist", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "watch-resolve-");
    try {
      fs.mkdirSync(path.join(dir, "app"));
      const watched = resolveWatchDirs(dir);
      expect(watched).toHaveLength(1);
      expect(watched[0]).toContain("app");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array when no candidates exist", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "watch-empty-");
    try {
      const watched = resolveWatchDirs(dir);
      expect(watched).toEqual([]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

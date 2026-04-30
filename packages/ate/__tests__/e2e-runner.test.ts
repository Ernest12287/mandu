import type * as __ManduNodeChildProcessTypes0 from "node:child_process";
/**
 * Tests for `packages/ate/src/e2e-runner.ts`.
 *
 * We cannot exercise the real Playwright spawn in CI, so these tests
 * focus on the deterministic parts:
 *
 *  - `findMissingPlaywright` detects peer presence via node_modules.
 *  - `buildPlaywrightArgs` composes cmd / args / env correctly under
 *    various flag combinations.
 *  - `planE2ERun` returns a dry-run descriptor with warnings.
 *  - `runE2E` with a stubbed `spawnImpl` surfaces the exit code.
 *  - `findMissingPlaywright` pre-flight causes `runE2E` to bail with
 *    exit code 4 (config error) and a missingPeer payload.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

import {
  buildPlaywrightArgs,
  describeE2EPlan,
  E2E_COVERAGE_RELATIVE,
  findMissingPlaywright,
  planE2ERun,
  runE2E,
} from "../src/e2e-runner";

const PREFIX = path.join(os.tmpdir(), "mandu-e2e-runner-");

/** Build a project dir that looks like it has Playwright installed. */
async function setupProjectWithPlaywright(): Promise<string> {
  const dir = await fs.promises.mkdtemp(PREFIX + "with-");
  const pw = path.join(dir, "node_modules", "@playwright", "test");
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, "package.json"), JSON.stringify({ name: "@playwright/test" }));
  const configDir = path.join(dir, "tests", "e2e");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "playwright.config.ts"), "// fixture");
  return dir;
}

async function setupProjectMissingPlaywright(): Promise<string> {
  return fs.promises.mkdtemp(PREFIX + "missing-");
}

// ═══════════════════════════════════════════════════════════════════════════
// findMissingPlaywright
// ═══════════════════════════════════════════════════════════════════════════

describe("findMissingPlaywright", () => {
  it("returns null when @playwright/test is installed", async () => {
    const dir = await setupProjectWithPlaywright();
    try {
      expect(findMissingPlaywright(dir)).toBeNull();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns '@playwright/test' when missing", async () => {
    const dir = await setupProjectMissingPlaywright();
    try {
      expect(findMissingPlaywright(dir)).toBe("@playwright/test");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts the older 'playwright' package as a fallback", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "legacy-");
    try {
      const pw = path.join(dir, "node_modules", "playwright");
      fs.mkdirSync(pw, { recursive: true });
      fs.writeFileSync(path.join(pw, "package.json"), JSON.stringify({ name: "playwright" }));
      expect(findMissingPlaywright(dir)).toBeNull();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPlaywrightArgs
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPlaywrightArgs", () => {
  it("uses bunx + playwright test + --config by default", () => {
    const result = buildPlaywrightArgs({ repoRoot: "/repo" });
    expect(result.cmd).toBe("bunx");
    expect(result.args[0]).toBe("playwright");
    expect(result.args[1]).toBe("test");
    expect(result.args).toContain("--config");
  });

  it("forwards CI=true when ci flag is set", () => {
    const { env } = buildPlaywrightArgs({ repoRoot: "/repo", ci: true });
    expect(env.CI).toBe("true");
  });

  it("sets BASE_URL from input or falls back to default", () => {
    const a = buildPlaywrightArgs({ repoRoot: "/r", baseURL: "http://x.test" });
    expect(a.env.BASE_URL).toBe("http://x.test");
    const b = buildPlaywrightArgs({ repoRoot: "/r" });
    expect(b.env.BASE_URL).toBe("http://localhost:3333");
  });

  it("appends --grep with regex-escaped route ids joined by |", () => {
    const { args } = buildPlaywrightArgs({
      repoRoot: "/r",
      onlyRoutes: ["/api/users", "/api/posts/*"],
    });
    const idx = args.indexOf("--grep");
    expect(idx).toBeGreaterThan(-1);
    // Forward slashes are NOT regex-special — they pass through unchanged.
    expect(args[idx + 1]).toContain("/api/users");
    expect(args[idx + 1]).toContain("|");
    // `*` IS a regex metacharacter so it must be escaped to `\*`.
    expect(args[idx + 1]).toContain("\\*");
  });

  it("appends --project per browser", () => {
    const { args } = buildPlaywrightArgs({
      repoRoot: "/r",
      browsers: ["chromium", "firefox"],
    });
    const projects = args.filter((_, i) => args[i - 1] === "--project");
    expect(projects).toEqual(["chromium", "firefox"]);
  });

  it("enables coverage env + resolves lcov path under the repo", () => {
    const { env, lcovPath } = buildPlaywrightArgs({
      repoRoot: "/repo",
      coverage: true,
    });
    expect(env.PW_COVERAGE).toBe("1");
    expect(lcovPath).toBeDefined();
    expect(lcovPath!.split(path.sep).join("/")).toContain(
      E2E_COVERAGE_RELATIVE.split(path.sep).join("/"),
    );
  });

  it("omits coverage env when coverage is off", () => {
    const { env, lcovPath } = buildPlaywrightArgs({ repoRoot: "/repo" });
    expect(env.PW_COVERAGE).toBeUndefined();
    expect(lcovPath).toBeNull();
  });

  it("accepts a custom configPath", () => {
    const { configPath } = buildPlaywrightArgs({
      repoRoot: "/repo",
      configPath: "/repo/custom/pw.ts",
    });
    expect(configPath).toBe("/repo/custom/pw.ts");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// planE2ERun
// ═══════════════════════════════════════════════════════════════════════════

describe("planE2ERun", () => {
  it("returns warnings when playwright is missing", async () => {
    const dir = await setupProjectMissingPlaywright();
    try {
      const plan = planE2ERun({ repoRoot: dir });
      expect(plan.warnings.some((w) => w.includes("Playwright peer dep"))).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns warnings when config is missing", async () => {
    const dir = await setupProjectWithPlaywright();
    try {
      // Delete the fixture config file
      await fs.promises.rm(path.join(dir, "tests", "e2e", "playwright.config.ts"));
      const plan = planE2ERun({ repoRoot: dir });
      expect(plan.warnings.some((w) => w.includes("config not found"))).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("includes lcov path in the plan when coverage is on", () => {
    const plan = planE2ERun({ repoRoot: "/tmp/fake", coverage: true });
    expect(plan.lcovPath).not.toBeNull();
  });

  it("describeE2EPlan produces a human-readable block", () => {
    const plan = planE2ERun({ repoRoot: "/tmp/fake", coverage: true });
    const text = describeE2EPlan(plan);
    expect(text).toContain("ATE E2E execution plan");
    expect(text).toContain("bunx");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runE2E with stubbed spawn
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A minimal `spawn` stand-in that emits `exit` with a configurable code
 * and returns an EventEmitter shape compatible with `node:child_process`.
 */
function createStubSpawn(exitCode: number) {
  return () => {
    const ee = new EventEmitter() as EventEmitter & { kill: () => void };
    ee.kill = () => {
      /* no-op */
    };
    // Emit on next tick so `.on('exit', ...)` is registered first.
    setImmediate(() => ee.emit("exit", exitCode));
    // The real spawn returns a ChildProcess; we satisfy the narrow subset
    // the runner uses via the cast.
    return ee as unknown as ReturnType<typeof __ManduNodeChildProcessTypes0.spawn>;
  };
}

describe("runE2E", () => {
  it("returns exit code 4 with missingPeer when playwright absent", async () => {
    const dir = await setupProjectMissingPlaywright();
    try {
      const result = await runE2E({ repoRoot: dir });
      expect(result.exitCode).toBe(4);
      expect(result.missingPeer).toBe("@playwright/test");
      expect(result.warnings[0]).toContain("peer dep not installed");
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 when stubbed spawn exits with 0", async () => {
    const dir = await setupProjectWithPlaywright();
    try {
      const result = await runE2E({
        repoRoot: dir,
        spawnImpl: createStubSpawn(0) as typeof __ManduNodeChildProcessTypes0.spawn,
      });
      expect(result.exitCode).toBe(0);
      expect(result.missingPeer).toBeNull();
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("propagates non-zero exit from the stubbed spawn", async () => {
    const dir = await setupProjectWithPlaywright();
    try {
      const result = await runE2E({
        repoRoot: dir,
        spawnImpl: createStubSpawn(1) as typeof __ManduNodeChildProcessTypes0.spawn,
      });
      expect(result.exitCode).toBe(1);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns 124 when the run exceeds timeoutMs", async () => {
    const dir = await setupProjectWithPlaywright();
    try {
      // Stub that never emits exit.
      const stubSpawn = (() => {
        const ee = new EventEmitter() as EventEmitter & { kill: () => void };
        ee.kill = () => {
          /* no-op */
        };
        return ee as unknown as ReturnType<typeof __ManduNodeChildProcessTypes0.spawn>;
      }) as unknown as typeof __ManduNodeChildProcessTypes0.spawn;

      const result = await runE2E({
        repoRoot: dir,
        spawnImpl: stubSpawn,
        timeoutMs: 30,
      });
      expect(result.exitCode).toBe(124);
      expect(result.warnings.some((w) => w.includes("exceeded timeout"))).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #250 — planDeploy() override hierarchy + diff tests.
 *
 * planDeploy is the pure function the CLI wraps. We test the override
 * hierarchy directly here:
 *
 *   1. explicit > cached > inferred
 *   2. cached when sourceHash unchanged → reuse
 *   3. cached when sourceHash differs → re-infer
 *   4. removed entries surface in the diff
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { planDeploy, planHasChanges } from "../../src/deploy/plan";
import {
  emptyDeployIntentCache,
  type DeployIntentCache,
} from "../../src/deploy/cache";
import type { RoutesManifest, RouteSpec } from "../../src/spec/schema";
import { hashSource } from "../../src/deploy/inference/context";

const FIXED_NOW = "2026-04-30T00:00:00.000Z";

describe("planDeploy — first run on an empty cache", () => {
  let TEST_DIR: string;

  beforeEach(async () => {
    TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-deploy-plan-"));
    await fs.mkdir(path.join(TEST_DIR, "app", "api", "embed"), { recursive: true });
    await fs.writeFile(
      path.join(TEST_DIR, "app", "api", "embed", "route.ts"),
      `export default async function POST() { return new Response("ok"); }`,
    );
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("infers an intent for every route on first run", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          id: "api/embed",
          pattern: "/api/embed",
          module: "app/api/embed/route.ts",
          kind: "api",
        } as RouteSpec,
      ],
    };
    const result = await planDeploy({
      rootDir: TEST_DIR,
      manifest,
      now: () => FIXED_NOW,
    });
    expect(result.cache.intents["api/embed"]?.intent.runtime).toBe("edge");
    expect(result.diff[0]?.kind).toBe("added");
    expect(planHasChanges(result.diff)).toBe(true);
  });
});

describe("planDeploy — caching skips unchanged sources", () => {
  let TEST_DIR: string;
  const SOURCE = `export default async function POST() { return new Response("ok"); }`;

  beforeEach(async () => {
    TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-deploy-plan-"));
    await fs.mkdir(path.join(TEST_DIR, "app", "api", "embed"), { recursive: true });
    await fs.writeFile(path.join(TEST_DIR, "app", "api", "embed", "route.ts"), SOURCE);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("reuses the prior entry when sourceHash matches", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        { id: "api/embed", pattern: "/api/embed", module: "app/api/embed/route.ts", kind: "api" } as RouteSpec,
      ],
    };
    const previous: DeployIntentCache = {
      version: 1,
      generatedAt: FIXED_NOW,
      brainModel: "heuristic",
      intents: {
        "api/embed": {
          intent: { runtime: "node", cache: "no-store", visibility: "public" },
          source: "inferred",
          rationale: "old reasoning",
          sourceHash: hashSource(SOURCE),
          inferredAt: FIXED_NOW,
        },
      },
    };

    let inferCalls = 0;
    const result = await planDeploy({
      rootDir: TEST_DIR,
      manifest,
      previous,
      now: () => FIXED_NOW,
      infer: () => {
        inferCalls++;
        return { intent: { runtime: "edge", cache: "no-store", visibility: "public" }, rationale: "should not be called" };
      },
    });

    expect(inferCalls).toBe(0);
    expect(result.cache.intents["api/embed"]?.intent.runtime).toBe("node");
    expect(result.diff[0]?.kind).toBe("unchanged");
    expect(planHasChanges(result.diff)).toBe(false);
  });

  it("re-infers when sourceHash differs", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        { id: "api/embed", pattern: "/api/embed", module: "app/api/embed/route.ts", kind: "api" } as RouteSpec,
      ],
    };
    const previous: DeployIntentCache = {
      version: 1,
      generatedAt: FIXED_NOW,
      brainModel: "heuristic",
      intents: {
        "api/embed": {
          intent: { runtime: "node", cache: "no-store", visibility: "public" },
          source: "inferred",
          rationale: "old",
          sourceHash: "stale".padEnd(64, "0"),
          inferredAt: FIXED_NOW,
        },
      },
    };
    const result = await planDeploy({
      rootDir: TEST_DIR,
      manifest,
      previous,
      now: () => FIXED_NOW,
    });
    expect(result.diff[0]?.kind).toBe("changed");
    expect(result.cache.intents["api/embed"]?.intent.runtime).toBe("edge");
  });

  it("--reinfer forces re-inference even on matching hash", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        { id: "api/embed", pattern: "/api/embed", module: "app/api/embed/route.ts", kind: "api" } as RouteSpec,
      ],
    };
    const previous: DeployIntentCache = {
      version: 1,
      generatedAt: FIXED_NOW,
      brainModel: "heuristic",
      intents: {
        "api/embed": {
          intent: { runtime: "node", cache: "no-store", visibility: "public" },
          source: "inferred",
          rationale: "old",
          sourceHash: hashSource(SOURCE),
          inferredAt: FIXED_NOW,
        },
      },
    };
    let inferCalls = 0;
    await planDeploy({
      rootDir: TEST_DIR,
      manifest,
      previous,
      reinfer: true,
      now: () => FIXED_NOW,
      infer: () => {
        inferCalls++;
        return { intent: { runtime: "edge", cache: "no-store", visibility: "public" }, rationale: "fresh" };
      },
    });
    expect(inferCalls).toBe(1);
  });
});

describe("planDeploy — explicit overrides are sacred", () => {
  let TEST_DIR: string;

  beforeEach(async () => {
    TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-deploy-plan-"));
    await fs.mkdir(path.join(TEST_DIR, "app", "api", "embed"), { recursive: true });
    await fs.writeFile(
      path.join(TEST_DIR, "app", "api", "embed", "route.ts"),
      "any source",
    );
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("never calls the inferer for explicit entries", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        { id: "api/embed", pattern: "/api/embed", module: "app/api/embed/route.ts", kind: "api" } as RouteSpec,
      ],
    };
    const previous: DeployIntentCache = {
      version: 1,
      generatedAt: FIXED_NOW,
      brainModel: "manual",
      intents: {
        "api/embed": {
          intent: { runtime: "bun", cache: "no-store", visibility: "private", regions: ["icn1"] },
          source: "explicit",
          rationale: "user pinned",
          sourceHash: "outdated".padEnd(64, "0"),
        },
      },
    };
    let inferCalls = 0;
    const result = await planDeploy({
      rootDir: TEST_DIR,
      manifest,
      previous,
      now: () => FIXED_NOW,
      infer: () => {
        inferCalls++;
        return { intent: { runtime: "edge", cache: "no-store", visibility: "public" }, rationale: "x" };
      },
    });
    expect(inferCalls).toBe(0);
    const entry = result.cache.intents["api/embed"]!;
    expect(entry.source).toBe("explicit");
    expect(entry.intent.runtime).toBe("bun");
    expect(entry.intent.visibility).toBe("private");
    expect(result.diff[0]?.kind).toBe("pinned");
  });
});

describe("planDeploy — removed entries", () => {
  it("surfaces routes that vanished from the manifest as removed", async () => {
    const TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-deploy-plan-"));
    try {
      const manifest: RoutesManifest = { version: 1, routes: [] };
      const previous = emptyDeployIntentCache();
      previous.intents["api/old"] = {
        intent: { runtime: "edge", cache: "no-store", visibility: "public" },
        source: "inferred",
        rationale: "stale",
        sourceHash: "x".repeat(64),
      };
      const result = await planDeploy({
        rootDir: TEST_DIR,
        manifest,
        previous,
        now: () => FIXED_NOW,
      });
      expect(result.cache.intents["api/old"]).toBeUndefined();
      expect(result.diff[0]?.kind).toBe("removed");
    } finally {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    }
  });
});

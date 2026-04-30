/**
 * Issue #250 — DeployIntentCache I/O round-trip tests.
 *
 * The cache file is committed to user repos, so its format and the
 * read/write contract are part of the public surface — bumps here
 * should match a `version` increment.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  DEPLOY_INTENT_CACHE_FILE,
  emptyDeployIntentCache,
  loadDeployIntentCache,
  resolveDeployIntentCachePath,
  saveDeployIntentCache,
  type DeployIntentCache,
} from "../../src/deploy/cache";

describe("DeployIntentCache I/O", () => {
  let TEST_DIR: string;

  beforeEach(async () => {
    TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-deploy-cache-"));
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns an empty cache when the file is missing", async () => {
    const cache = await loadDeployIntentCache(TEST_DIR);
    expect(cache.version).toBe(1);
    expect(Object.keys(cache.intents)).toHaveLength(0);
  });

  it("round-trips through save → load with field equality", async () => {
    const cache: DeployIntentCache = {
      version: 1,
      generatedAt: "2026-04-30T00:00:00.000Z",
      brainModel: "heuristic",
      intents: {
        "api/embed": {
          intent: { runtime: "edge", cache: "no-store", visibility: "public" },
          source: "inferred",
          rationale: "stateless API",
          sourceHash: "a".repeat(64),
          inferredAt: "2026-04-30T00:00:00.000Z",
        },
      },
    };
    await saveDeployIntentCache(TEST_DIR, cache);
    const loaded = await loadDeployIntentCache(TEST_DIR);
    expect(loaded).toEqual(cache);
  });

  it("writes to the canonical path", async () => {
    const cache = emptyDeployIntentCache();
    await saveDeployIntentCache(TEST_DIR, cache);
    const exists = await fs
      .stat(path.join(TEST_DIR, DEPLOY_INTENT_CACHE_FILE))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
    expect(resolveDeployIntentCachePath(TEST_DIR)).toBe(
      path.join(TEST_DIR, DEPLOY_INTENT_CACHE_FILE),
    );
  });

  it("emits intents in stable key order so diffs stay clean", async () => {
    const cache: DeployIntentCache = {
      version: 1,
      generatedAt: "2026-04-30T00:00:00.000Z",
      brainModel: "heuristic",
      intents: {
        "z-route": {
          intent: { runtime: "edge", cache: "no-store", visibility: "public" },
          source: "inferred",
          rationale: "z",
          sourceHash: "z".repeat(64),
        },
        "a-route": {
          intent: { runtime: "edge", cache: "no-store", visibility: "public" },
          source: "inferred",
          rationale: "a",
          sourceHash: "a".repeat(64),
        },
      },
    };
    await saveDeployIntentCache(TEST_DIR, cache);
    const raw = await fs.readFile(resolveDeployIntentCachePath(TEST_DIR), "utf8");
    expect(raw.indexOf("a-route")).toBeLessThan(raw.indexOf("z-route"));
  });

  it("rejects malformed JSON loudly", async () => {
    await fs.mkdir(path.join(TEST_DIR, ".mandu"), { recursive: true });
    await fs.writeFile(
      path.join(TEST_DIR, DEPLOY_INTENT_CACHE_FILE),
      "{not valid json",
      "utf8",
    );
    await expect(loadDeployIntentCache(TEST_DIR)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a structurally invalid cache loudly", async () => {
    await fs.mkdir(path.join(TEST_DIR, ".mandu"), { recursive: true });
    await fs.writeFile(
      path.join(TEST_DIR, DEPLOY_INTENT_CACHE_FILE),
      JSON.stringify({ version: 1, generatedAt: "2026-04-30T00:00:00.000Z", intents: { a: { invalid: true } } }),
      "utf8",
    );
    await expect(loadDeployIntentCache(TEST_DIR)).rejects.toThrow();
  });
});

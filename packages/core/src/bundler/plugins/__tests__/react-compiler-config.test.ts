/**
 * `resolveReactCompilerConfig` — #240 Phase 2 auto-detect tests.
 *
 * The probe only fires when `enabled` is undefined. Explicit `true` /
 * `false` veto the probe so user intent always wins.
 *
 * Cache lifetime is per-process; we reset it between cases so a probe
 * from one fixture doesn't leak to the next.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveReactCompilerConfig,
  _resetReactCompilerConfigCache,
} from "../react-compiler-config";

async function makeRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `mandu-rc-${prefix}-`));
}

beforeEach(() => {
  _resetReactCompilerConfigCache();
});

describe("resolveReactCompilerConfig", () => {
  it("explicit enabled:true honours the user even when peers are missing", async () => {
    const root = await makeRoot("explicit-on");
    const result = resolveReactCompilerConfig({ enabled: true }, root);
    expect(result.enabled).toBe(true);
    expect(result.autoDetected).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("explicit enabled:false vetos the probe", async () => {
    const root = await makeRoot("explicit-off");
    const result = resolveReactCompilerConfig({ enabled: false }, root);
    expect(result.enabled).toBe(false);
    expect(result.autoDetected).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("undefined enabled + missing peers → disabled silently", async () => {
    const root = await makeRoot("auto-no-peers");
    // Empty rootDir — no node_modules, no package.json, no peer deps.
    const result = resolveReactCompilerConfig(undefined, root);
    expect(result.enabled).toBe(false);
    expect(result.autoDetected).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("forwards compilerConfig regardless of enabled state", async () => {
    const root = await makeRoot("compiler-config");
    const cfg = { compilationMode: "annotation" };
    const result = resolveReactCompilerConfig(
      { enabled: true, compilerConfig: cfg },
      root,
    );
    expect(result.compilerConfig).toBe(cfg);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("caches by (rootDir, explicit-enabled) — second call hits cache", async () => {
    const root = await makeRoot("cache");
    const a = resolveReactCompilerConfig(undefined, root);
    const b = resolveReactCompilerConfig(undefined, root);
    // Same identity — cache hit returns the stored object.
    expect(a).toBe(b);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("treats explicit-true vs auto as separate cache keys", async () => {
    const root = await makeRoot("cache-key");
    const auto = resolveReactCompilerConfig(undefined, root);
    const explicit = resolveReactCompilerConfig({ enabled: true }, root);
    expect(auto).not.toBe(explicit);
    expect(auto.enabled).toBe(false);
    expect(explicit.enabled).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});

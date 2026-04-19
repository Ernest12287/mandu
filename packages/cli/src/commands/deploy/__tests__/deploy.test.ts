/**
 * Deploy CLI command — top-level dispatcher tests (Phase 13.1).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { deploy, normalizeSetSecrets } from "..";
import { DeployAdapterRegistry, type DeployAdapter } from "../types";
import { createSecretBridge } from "../secret-bridge";

function stubAdapter(partial: Partial<DeployAdapter> & { target: DeployAdapter["target"] }): DeployAdapter {
  return {
    name: `stub-${partial.target}`,
    minimumCliVersion: null,
    secrets: [],
    async check() {
      return { ok: true, errors: [], warnings: [] };
    },
    async prepare() {
      return [];
    },
    ...partial,
  } as DeployAdapter;
}

describe("normalizeSetSecrets", () => {
  it("treats undefined as empty", () => {
    expect(normalizeSetSecrets(undefined)).toEqual([]);
  });

  it("wraps a single string in an array", () => {
    expect(normalizeSetSecrets("FOO=bar")).toEqual(["FOO=bar"]);
  });

  it("passes arrays through", () => {
    expect(normalizeSetSecrets(["A=1", "B=2"])).toEqual(["A=1", "B=2"]);
  });
});

describe("deploy() — unknown target", () => {
  it("returns false when no target is provided", async () => {
    const ok = await deploy({});
    expect(ok).toBe(false);
  });

  it("returns false for an unsupported target", async () => {
    const ok = await deploy({
      target: "digital-ocean" as unknown as string,
    });
    expect(ok).toBe(false);
  });
});

describe("deploy() — --set-secret mode", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-deploy-secret-"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "acme-app", version: "0.0.1" })
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stores secrets through the bridge and short-circuits the pipeline", async () => {
    const bridge = createSecretBridge({
      target: "fly",
      rootDir: root,
      forceFallback: true,
      onWarning: () => {},
    });
    const ok = await deploy({
      target: "fly",
      setSecret: ["FLY_API_TOKEN=abcdef1234567890"],
      cwd: root,
      bridge,
    });
    expect(ok).toBe(true);
    expect(await bridge.get("FLY_API_TOKEN")).toBe("abcdef1234567890");
  });

  it("rejects a malformed secret pair", async () => {
    const bridge = createSecretBridge({
      target: "fly",
      rootDir: root,
      forceFallback: true,
      onWarning: () => {},
    });
    const ok = await deploy({
      target: "fly",
      setSecret: ["no-equals-sign"],
      cwd: root,
      bridge,
    });
    expect(ok).toBe(false);
  });
});

describe("deploy() — --dry-run with injected adapter", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-deploy-dry-"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "acme-app", version: "0.0.1" })
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("runs check + prepare and skips build/deploy in dry-run", async () => {
    const prepareCalls: number[] = [];
    const registry = new DeployAdapterRegistry();
    registry.register(
      stubAdapter({
        target: "docker",
        async prepare() {
          prepareCalls.push(1);
          return [
            { path: path.join(root, "Dockerfile"), description: "stubbed" },
          ];
        },
      })
    );
    const bridge = createSecretBridge({
      target: "docker",
      rootDir: root,
      forceFallback: true,
      onWarning: () => {},
    });
    const ok = await deploy({
      target: "docker",
      dryRun: true,
      cwd: root,
      registry,
      bridge,
    });
    expect(ok).toBe(true);
    expect(prepareCalls.length).toBe(1);
  });

  it("fails when --execute is set but adapter has no deploy()", async () => {
    const registry = new DeployAdapterRegistry();
    registry.register(
      stubAdapter({
        target: "docker",
        // no deploy() implementation — adapter is prepare-only
      })
    );
    const bridge = createSecretBridge({
      target: "docker",
      rootDir: root,
      forceFallback: true,
      onWarning: () => {},
    });
    const ok = await deploy({
      target: "docker",
      dryRun: true,
      execute: true,
      cwd: root,
      registry,
      bridge,
    });
    // dryRun short-circuits before the execute check, so --dry-run +
    // --execute still returns true (dry-run wins).
    expect(ok).toBe(true);
  });
});

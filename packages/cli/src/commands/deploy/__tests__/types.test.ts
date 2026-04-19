/**
 * DeployAdapterRegistry + type guard tests (Phase 13.1).
 */
import { describe, expect, it } from "bun:test";
import {
  DEPLOY_ENVIRONMENTS,
  DEPLOY_TARGETS,
  DeployAdapterRegistry,
  isDeployEnvironment,
  isDeployTarget,
  type DeployAdapter,
} from "../types";

function stubAdapter(target: DeployAdapter["target"]): DeployAdapter {
  return {
    name: `stub-${target}`,
    target,
    minimumCliVersion: null,
    secrets: [],
    async check() {
      return { ok: true, errors: [], warnings: [] };
    },
    async prepare() {
      return [];
    },
  };
}

describe("DeployAdapterRegistry", () => {
  it("register + get + has + size", () => {
    const r = new DeployAdapterRegistry();
    expect(r.size()).toBe(0);
    r.register(stubAdapter("docker"));
    expect(r.size()).toBe(1);
    expect(r.has("docker")).toBe(true);
    expect(r.get("docker")?.name).toBe("stub-docker");
    expect(r.get("fly")).toBeUndefined();
    expect(r.has("fly")).toBe(false);
  });

  it("rejects duplicate registration", () => {
    const r = new DeployAdapterRegistry();
    r.register(stubAdapter("docker"));
    expect(() => r.register(stubAdapter("docker"))).toThrow(/duplicate/i);
  });

  it("list() returns adapters sorted by target id", () => {
    const r = new DeployAdapterRegistry();
    r.register(stubAdapter("vercel"));
    r.register(stubAdapter("docker"));
    r.register(stubAdapter("fly"));
    expect(r.list().map((a) => a.target)).toEqual(["docker", "fly", "vercel"]);
  });
});

describe("isDeployTarget", () => {
  it("accepts every enumerated target", () => {
    for (const t of DEPLOY_TARGETS) {
      expect(isDeployTarget(t)).toBe(true);
    }
  });

  it("rejects foreign strings + non-strings", () => {
    expect(isDeployTarget("digital-ocean")).toBe(false);
    expect(isDeployTarget("")).toBe(false);
    expect(isDeployTarget(42)).toBe(false);
    expect(isDeployTarget(undefined)).toBe(false);
  });
});

describe("isDeployEnvironment", () => {
  it("accepts every enumerated env", () => {
    for (const e of DEPLOY_ENVIRONMENTS) {
      expect(isDeployEnvironment(e)).toBe(true);
    }
  });

  it("rejects other values", () => {
    expect(isDeployEnvironment("dev")).toBe(false);
    expect(isDeployEnvironment("")).toBe(false);
    expect(isDeployEnvironment(null)).toBe(false);
  });
});

/**
 * Provider-CLI helper — version parsing + spawn stubs (Phase 13.1).
 */
import { describe, expect, it } from "bun:test";
import {
  compareVersions,
  extractVersion,
  getProviderCliStatus,
  satisfiesMinimum,
  type SpawnVersion,
} from "../provider-cli";

describe("extractVersion", () => {
  it("pulls major.minor.patch from `--version` output", () => {
    expect(extractVersion("flyctl v0.3.87 darwin/arm64")).toBe("0.3.87");
    expect(extractVersion("wrangler 3.78.0")).toBe("3.78.0");
    expect(extractVersion("Vercel CLI 28.3.1")).toBe("28.3.1");
  });

  it("pads missing patch to .0", () => {
    expect(extractVersion("v1.2")).toBe("1.2.0");
  });

  it("returns null when no version-like substring present", () => {
    expect(extractVersion("no version here")).toBeNull();
    expect(extractVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders equal / less / greater", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.99")).toBe(1);
  });

  it("tolerates v-prefixed + missing components", () => {
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
    expect(compareVersions("0.1", "0.0.9")).toBe(1);
  });

  it("satisfiesMinimum is compareVersions-based >=", () => {
    expect(satisfiesMinimum("1.2.3", "1.2.0")).toBe(true);
    expect(satisfiesMinimum("1.0.0", "1.0.0")).toBe(true);
    expect(satisfiesMinimum("0.9.9", "1.0.0")).toBe(false);
  });
});

function makeStubSpawn(stdout: string, exitCode = 0, notFound = false): SpawnVersion {
  return async () => ({ stdout, stderr: "", exitCode, notFound });
}

describe("getProviderCliStatus", () => {
  it("reports installed + meets minimum", async () => {
    const status = await getProviderCliStatus("flyctl", "0.1.0", {
      spawnImpl: makeStubSpawn("flyctl v0.3.87 darwin/arm64"),
    });
    expect(status.installed).toBe(true);
    expect(status.version).toBe("0.3.87");
    expect(status.meetsMinimum).toBe(true);
  });

  it("reports outdated when below minimum", async () => {
    const status = await getProviderCliStatus("flyctl", "1.0.0", {
      spawnImpl: makeStubSpawn("flyctl v0.3.87"),
    });
    expect(status.installed).toBe(true);
    expect(status.version).toBe("0.3.87");
    expect(status.meetsMinimum).toBe(false);
  });

  it("reports not installed when spawn flags notFound", async () => {
    const status = await getProviderCliStatus("nonexistent", "1.0.0", {
      spawnImpl: makeStubSpawn("", 127, true),
    });
    expect(status.installed).toBe(false);
    expect(status.version).toBeNull();
    expect(status.meetsMinimum).toBe(false);
  });

  it("falls back to stderr when stdout is empty", async () => {
    const status = await getProviderCliStatus("vercel", "1.0.0", {
      spawnImpl: async () => ({
        stdout: "",
        stderr: "Vercel CLI 28.3.1\n",
        exitCode: 0,
        notFound: false,
      }),
    });
    expect(status.version).toBe("28.3.1");
    expect(status.meetsMinimum).toBe(true);
  });

  it("treats silent exit 127 as not installed", async () => {
    const status = await getProviderCliStatus("flyctl", "0.1.0", {
      spawnImpl: makeStubSpawn("", 127, false),
    });
    expect(status.installed).toBe(false);
  });
});

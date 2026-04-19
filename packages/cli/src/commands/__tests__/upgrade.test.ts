/**
 * Unit tests for `packages/cli/src/commands/upgrade.ts`.
 *
 * Covers the pure helpers (`parseChecksums`, `compareSemver`,
 * `detectTargetLabel`, `isBinaryMode`) + `atomicReplaceBinary` /
 * `downloadAndVerify` against `fs.mkdtemp` fixtures. Network calls
 * are mocked via the `fetchImpl` option so no real GitHub traffic
 * occurs.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import {
  __private,
  upgradeRun,
  EXIT_OK,
  EXIT_ERROR,
  type UpgradeOptions,
} from "../upgrade";

const PREFIX = path.join(os.tmpdir(), "mandu-upgrade-test-");

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(PREFIX);
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

// =====================================================================
// Pure helpers
// =====================================================================

describe("parseChecksums", () => {
  it("parses standard sha256sum output", () => {
    // 64 hex digits each — real SHA-256 output.
    const sha1 = "aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999";
    const sha2 = "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff";
    const body = [
      `${sha1}  mandu-bun-linux-x64`,
      `${sha2}  mandu-bun-windows-x64.exe`,
      "",
      "# comment line",
    ].join("\n");
    const map = __private.parseChecksums(body);
    expect(map.size).toBe(2);
    expect(map.get("mandu-bun-linux-x64")).toBe(sha1);
    expect(map.get("mandu-bun-windows-x64.exe")).toBe(sha2);
  });

  it("tolerates the `<hash> *<file>` binary marker", () => {
    const body =
      "aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999 *mandu-bun-linux-x64";
    const map = __private.parseChecksums(body);
    expect(map.get("mandu-bun-linux-x64")).toBeDefined();
  });

  it("skips malformed lines silently", () => {
    const body = [
      "not a checksum",
      "aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999  mandu-bun-linux-x64",
    ].join("\n");
    const map = __private.parseChecksums(body);
    expect(map.size).toBe(1);
  });
});

describe("compareSemver", () => {
  it("returns negative when a < b", () => {
    expect(__private.compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(__private.compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("returns zero when equal", () => {
    expect(__private.compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("strips the leading v prefix", () => {
    expect(__private.compareSemver("v1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("handles pre-release suffix by comparing the numeric core", () => {
    expect(__private.compareSemver("1.0.0-rc.1", "1.0.0")).toBe(0);
  });
});

describe("detectTargetLabel", () => {
  it("returns matrix labels for the four supported OS/arch pairs", () => {
    expect(__private.detectTargetLabel("linux", "x64")).toBe("bun-linux-x64");
    expect(__private.detectTargetLabel("linux", "arm64")).toBe("bun-linux-arm64");
    expect(__private.detectTargetLabel("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(__private.detectTargetLabel("darwin", "x64")).toBe("bun-darwin-x64");
    expect(__private.detectTargetLabel("win32", "x64")).toBe("bun-windows-x64");
  });

  it("returns null for unsupported combos", () => {
    expect(__private.detectTargetLabel("freebsd" as NodeJS.Platform, "x64")).toBeNull();
    expect(__private.detectTargetLabel("win32", "arm64")).toBeNull();
  });
});

describe("isBinaryMode", () => {
  it("returns false when execPath is bun or bun.exe", () => {
    expect(__private.isBinaryMode({ execPath: "/usr/local/bin/bun" })).toBe(false);
    expect(__private.isBinaryMode({ execPath: "C:\\bun\\bun.exe" })).toBe(false);
  });

  it("returns true for compile-binary filenames", () => {
    expect(__private.isBinaryMode({ execPath: "/usr/local/bin/mandu" })).toBe(true);
    expect(__private.isBinaryMode({ execPath: "C:\\tools\\mandu.exe" })).toBe(true);
    expect(__private.isBinaryMode({ execPath: "/opt/mandu-bun-linux-x64" })).toBe(true);
  });
});

// =====================================================================
// atomicReplaceBinary — POSIX-style rename semantics
// =====================================================================

describe("atomicReplaceBinary", () => {
  it("moves the new binary into place and stashes the old one", async () => {
    const currentPath = path.join(tmpHome, "mandu");
    const newFile = path.join(tmpHome, "new.bin");
    const previousDir = path.join(tmpHome, "previous");
    await fs.writeFile(currentPath, "OLD_VERSION_BYTES");
    await fs.writeFile(newFile, "NEW_VERSION_BYTES");

    const previousPath = await __private.atomicReplaceBinary(
      currentPath,
      newFile,
      previousDir,
    );
    // Current is now the new bytes.
    expect(await fs.readFile(currentPath, "utf8")).toBe("NEW_VERSION_BYTES");
    // Previous is stashed in the previous dir.
    expect(existsSync(previousPath)).toBe(true);
    expect(await fs.readFile(previousPath, "utf8")).toBe("OLD_VERSION_BYTES");
    // The staged newFile is gone (renamed).
    expect(existsSync(newFile)).toBe(false);
  });
});

// =====================================================================
// downloadAndVerify — integrity check fidelity
// =====================================================================

describe("downloadAndVerify", () => {
  it("writes bytes when the SHA-256 matches the expected value", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const expected = createHash("sha256").update(body).digest("hex");
    const fetchImpl = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch;

    const dest = path.join(tmpHome, "mandu.bin");
    await __private.downloadAndVerify(
      "https://example.com/mandu.bin",
      dest,
      expected,
      fetchImpl,
    );
    const written = await fs.readFile(dest);
    expect(written.length).toBe(5);
    expect(Array.from(written)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects on SHA-256 mismatch", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    await expect(
      __private.downloadAndVerify(
        "https://example.com/x.bin",
        path.join(tmpHome, "x.bin"),
        "deadbeef".repeat(8),
        fetchImpl,
      ),
    ).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("rejects when the server responds non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    await expect(
      __private.downloadAndVerify(
        "https://example.com/missing",
        path.join(tmpHome, "m.bin"),
        "0".repeat(64),
        fetchImpl,
      ),
    ).rejects.toThrow(/asset download failed/);
  });
});

// =====================================================================
// fetchLatestRelease — channel filtering
// =====================================================================

describe("fetchLatestRelease", () => {
  it("stable channel skips prereleases", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { tag_name: "v1.0.0-rc.1", name: "rc1", prerelease: true, assets: [] },
          { tag_name: "v0.23.0", name: "stable", prerelease: false, assets: [] },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const release = await __private.fetchLatestRelease(
      "konamgil/mandu",
      "stable",
      fetchImpl,
    );
    expect(release.tag_name).toBe("v0.23.0");
  });

  it("canary channel accepts the most recent including prereleases", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { tag_name: "v1.0.0-rc.2", name: "rc2", prerelease: true, assets: [] },
          { tag_name: "v0.23.0", name: "stable", prerelease: false, assets: [] },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const release = await __private.fetchLatestRelease(
      "konamgil/mandu",
      "canary",
      fetchImpl,
    );
    expect(release.tag_name).toBe("v1.0.0-rc.2");
  });

  it("throws on empty release list", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    await expect(
      __private.fetchLatestRelease("konamgil/mandu", "stable", fetchImpl),
    ).rejects.toThrow(/no releases/);
  });
});

// =====================================================================
// upgradeRun end-to-end via injected fetch — check mode
// =====================================================================

describe("upgradeRun — package mode --check", () => {
  it("exits 0 with --check regardless of available updates", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("registry.npmjs.org")) {
        return new Response(JSON.stringify({ version: "0.99.0" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const opts: UpgradeOptions = {
      check: true,
      fetchImpl,
      cwd: tmpHome, // empty tmp dir — no node_modules, so installed=not installed
      execPath: "/usr/local/bin/bun", // force package mode
    };
    const code = await upgradeRun(opts);
    expect(code).toBe(EXIT_OK);
  });
});

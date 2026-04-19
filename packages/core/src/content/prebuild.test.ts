/**
 * Tests for `content/prebuild.ts` (Issue #196).
 *
 * We exercise:
 *   - `discoverPrebuildScripts` globbing + sort determinism
 *   - `shouldAutoPrebuild` activation policy (content/ OR scripts/prebuild-*.ts)
 *   - `runPrebuildScripts` with an injected spawn hook (no actual subprocess)
 *     covering the success path, per-script fail-fast, timeout surface, and
 *     the empty-discovery no-op fast path.
 *
 * Spawning a real `bun` subprocess is intentionally avoided — those paths
 * belong in the CLI-level integration test. At this layer the Bun runtime
 * is mocked so the test doubles as a correctness guarantee for any Node
 * environment that later injects its own spawn hook.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  discoverPrebuildScripts,
  shouldAutoPrebuild,
  runPrebuildScripts,
  PrebuildError,
  type SpawnHook,
} from "./prebuild";

const PREFIX = path.join(os.tmpdir(), "mandu-prebuild-test-");

function mktmp(prefix = ""): string {
  return fs.mkdtempSync(PREFIX + prefix);
}

function writeFile(dir: string, rel: string, content = "// stub\n"): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// ---------------------------------------------------------------------------
// discoverPrebuildScripts
// ---------------------------------------------------------------------------

describe("discoverPrebuildScripts", () => {
  let dir = "";
  beforeEach(() => { dir = mktmp("discover-"); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns empty when scripts/ does not exist", () => {
    expect(discoverPrebuildScripts(dir)).toEqual([]);
  });

  it("returns empty when scripts/ exists but has no prebuild files", () => {
    writeFile(dir, "scripts/build.ts");
    writeFile(dir, "scripts/README.md");
    expect(discoverPrebuildScripts(dir)).toEqual([]);
  });

  it("finds prebuild-<name>.ts files", () => {
    writeFile(dir, "scripts/prebuild-docs.ts");
    writeFile(dir, "scripts/prebuild-seo.ts");
    const found = discoverPrebuildScripts(dir);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("prebuild-docs.ts");
    expect(found[1]).toContain("prebuild-seo.ts");
  });

  it("sorts lexicographically so numeric prefix controls ordering", () => {
    writeFile(dir, "scripts/prebuild-20-second.ts");
    writeFile(dir, "scripts/prebuild-10-first.ts");
    writeFile(dir, "scripts/prebuild-99-third.ts");
    const found = discoverPrebuildScripts(dir).map((p) => path.basename(p));
    expect(found).toEqual([
      "prebuild-10-first.ts",
      "prebuild-20-second.ts",
      "prebuild-99-third.ts",
    ]);
  });

  it("accepts .tsx, .js, .mjs extensions", () => {
    writeFile(dir, "scripts/prebuild-a.tsx");
    writeFile(dir, "scripts/prebuild-b.js");
    writeFile(dir, "scripts/prebuild-c.mjs");
    const found = discoverPrebuildScripts(dir).map((p) => path.basename(p));
    expect(found).toEqual(["prebuild-a.tsx", "prebuild-b.js", "prebuild-c.mjs"]);
  });

  it("rejects non-prebuild filenames even if in scripts/", () => {
    writeFile(dir, "scripts/my-prebuild.ts");       // doesn't start with prebuild
    writeFile(dir, "scripts/prebuild.py");           // wrong extension
    writeFile(dir, "scripts/prebuild-valid.ts");
    const found = discoverPrebuildScripts(dir).map((p) => path.basename(p));
    expect(found).toEqual(["prebuild-valid.ts"]);
  });

  it("honors custom scriptsDir", () => {
    writeFile(dir, "custom/prebuild-1.ts");
    expect(discoverPrebuildScripts(dir, "custom")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoPrebuild
// ---------------------------------------------------------------------------

describe("shouldAutoPrebuild", () => {
  let dir = "";
  beforeEach(() => { dir = mktmp("policy-"); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("false when neither content/ nor prebuild scripts exist", () => {
    expect(shouldAutoPrebuild(dir)).toBe(false);
  });

  it("true when content/ directory exists (even if empty)", () => {
    fs.mkdirSync(path.join(dir, "content"));
    expect(shouldAutoPrebuild(dir)).toBe(true);
  });

  it("true when a prebuild script exists but content/ does not", () => {
    writeFile(dir, "scripts/prebuild-docs.ts");
    expect(shouldAutoPrebuild(dir)).toBe(true);
  });

  it("false when content/ is a file, not a directory", () => {
    fs.writeFileSync(path.join(dir, "content"), "not a dir");
    expect(shouldAutoPrebuild(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPrebuildScripts with mock spawn
// ---------------------------------------------------------------------------

function makeMockSpawn(
  policy: (scriptPath: string) => { exitCode: number | null; durationMs: number } | Promise<{ exitCode: number | null; durationMs: number }>,
): SpawnHook & { calls: Array<{ scriptPath: string; cwd: string; timeoutMs: number }> } {
  const calls: Array<{ scriptPath: string; cwd: string; timeoutMs: number }> = [];
  const hook: SpawnHook = async (args) => {
    calls.push(args);
    return await policy(args.scriptPath);
  };
  return Object.assign(hook, { calls });
}

describe("runPrebuildScripts", () => {
  let dir = "";
  beforeEach(() => { dir = mktmp("run-"); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns { ran: 0 } when no scripts exist — silent no-op", async () => {
    const spawn = makeMockSpawn(() => ({ exitCode: 0, durationMs: 5 }));
    const result = await runPrebuildScripts({ rootDir: dir, spawn });
    expect(result.ran).toBe(0);
    expect(spawn.calls).toHaveLength(0);
  });

  it("runs discovered scripts in order", async () => {
    writeFile(dir, "scripts/prebuild-b.ts");
    writeFile(dir, "scripts/prebuild-a.ts");
    const order: string[] = [];
    const spawn = makeMockSpawn(async (p) => {
      order.push(path.basename(p));
      return { exitCode: 0, durationMs: 1 };
    });
    const result = await runPrebuildScripts({ rootDir: dir, spawn });
    expect(result.ran).toBe(2);
    expect(order).toEqual(["prebuild-a.ts", "prebuild-b.ts"]);
  });

  it("throws PrebuildError with exitCode on first non-zero exit", async () => {
    writeFile(dir, "scripts/prebuild-1.ts");
    writeFile(dir, "scripts/prebuild-2.ts");
    const spawn = makeMockSpawn((p) => ({
      exitCode: path.basename(p) === "prebuild-1.ts" ? 3 : 0,
      durationMs: 1,
    }));
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrebuildError);
    const err = caught as PrebuildError;
    expect(err.exitCode).toBe(3);
    expect(err.scriptPath).toContain("prebuild-1.ts");
    // prebuild-2.ts must NOT have been invoked (fail-fast chain semantics).
    expect(spawn.calls).toHaveLength(1);
  });

  it("wraps non-PrebuildError spawn rejections", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const spawn: SpawnHook = async () => {
      throw new Error("spawn ENOENT");
    };
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrebuildError);
    expect((caught as PrebuildError).message).toContain("spawn ENOENT");
  });

  it("invokes onStart / onFinish callbacks for each script", async () => {
    writeFile(dir, "scripts/prebuild-a.ts");
    writeFile(dir, "scripts/prebuild-b.ts");
    const starts: string[] = [];
    const finishes: Array<{ name: string; code: number | null }> = [];
    await runPrebuildScripts({
      rootDir: dir,
      spawn: async () => ({ exitCode: 0, durationMs: 1 }),
      onStart: (p, i, total) => {
        starts.push(`${i + 1}/${total}:${path.basename(p)}`);
      },
      onFinish: (r) => {
        finishes.push({ name: path.basename(r.scriptPath), code: r.exitCode });
      },
    });
    expect(starts).toEqual(["1/2:prebuild-a.ts", "2/2:prebuild-b.ts"]);
    expect(finishes).toEqual([
      { name: "prebuild-a.ts", code: 0 },
      { name: "prebuild-b.ts", code: 0 },
    ]);
  });

  it("threads timeoutMs through to the spawn hook", async () => {
    writeFile(dir, "scripts/prebuild-1.ts");
    const spawn = makeMockSpawn(() => ({ exitCode: 0, durationMs: 1 }));
    await runPrebuildScripts({
      rootDir: dir,
      spawn,
      timeoutMs: 5_000,
    });
    expect(spawn.calls[0].timeoutMs).toBe(5_000);
  });

  it("uses default 2-minute timeout when not overridden", async () => {
    writeFile(dir, "scripts/prebuild-1.ts");
    const spawn = makeMockSpawn(() => ({ exitCode: 0, durationMs: 1 }));
    await runPrebuildScripts({ rootDir: dir, spawn });
    expect(spawn.calls[0].timeoutMs).toBe(2 * 60 * 1000);
  });
});

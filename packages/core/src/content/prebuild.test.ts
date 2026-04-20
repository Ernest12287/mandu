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
  PrebuildTimeoutError,
  resolvePrebuildTimeout,
  DEFAULT_PREBUILD_TIMEOUT_MS,
  PREBUILD_TIMEOUT_ENV,
  defaultSpawn,
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

// ---------------------------------------------------------------------------
// resolvePrebuildTimeout (Issue #203)
// ---------------------------------------------------------------------------

describe("resolvePrebuildTimeout", () => {
  const originalEnv = process.env[PREBUILD_TIMEOUT_ENV];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[PREBUILD_TIMEOUT_ENV];
    else process.env[PREBUILD_TIMEOUT_ENV] = originalEnv;
  });

  it("returns DEFAULT_PREBUILD_TIMEOUT_MS (120s) when no override", () => {
    delete process.env[PREBUILD_TIMEOUT_ENV];
    expect(resolvePrebuildTimeout()).toBe(DEFAULT_PREBUILD_TIMEOUT_MS);
    expect(DEFAULT_PREBUILD_TIMEOUT_MS).toBe(120_000);
  });

  it("explicit arg wins over env var", () => {
    process.env[PREBUILD_TIMEOUT_ENV] = "5000";
    expect(resolvePrebuildTimeout(1234)).toBe(1234);
  });

  it("env var is used when no explicit arg", () => {
    process.env[PREBUILD_TIMEOUT_ENV] = "7500";
    expect(resolvePrebuildTimeout()).toBe(7500);
  });

  it("ignores invalid env var (non-numeric) and falls back to default", () => {
    process.env[PREBUILD_TIMEOUT_ENV] = "not-a-number";
    expect(resolvePrebuildTimeout()).toBe(DEFAULT_PREBUILD_TIMEOUT_MS);
  });

  it("ignores invalid env var (zero / negative) and falls back to default", () => {
    process.env[PREBUILD_TIMEOUT_ENV] = "0";
    expect(resolvePrebuildTimeout()).toBe(DEFAULT_PREBUILD_TIMEOUT_MS);
    process.env[PREBUILD_TIMEOUT_ENV] = "-5";
    expect(resolvePrebuildTimeout()).toBe(DEFAULT_PREBUILD_TIMEOUT_MS);
  });

  it("ignores non-positive explicit arg", () => {
    delete process.env[PREBUILD_TIMEOUT_ENV];
    expect(resolvePrebuildTimeout(0)).toBe(DEFAULT_PREBUILD_TIMEOUT_MS);
    expect(resolvePrebuildTimeout(-1)).toBe(DEFAULT_PREBUILD_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// Issue #203 — Timeout + error surface regressions
// ---------------------------------------------------------------------------

describe("runPrebuildScripts — timeout surface (Issue #203)", () => {
  let dir = "";
  beforeEach(() => { dir = mktmp("timeout-"); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("honours MANDU_PREBUILD_TIMEOUT_MS env override when timeoutMs omitted", async () => {
    const originalEnv = process.env[PREBUILD_TIMEOUT_ENV];
    process.env[PREBUILD_TIMEOUT_ENV] = "9999";
    try {
      writeFile(dir, "scripts/prebuild-1.ts");
      const spawn = makeMockSpawn(() => ({ exitCode: 0, durationMs: 1 }));
      await runPrebuildScripts({ rootDir: dir, spawn });
      expect(spawn.calls[0].timeoutMs).toBe(9999);
    } finally {
      if (originalEnv === undefined) delete process.env[PREBUILD_TIMEOUT_ENV];
      else process.env[PREBUILD_TIMEOUT_ENV] = originalEnv;
    }
  });

  it("explicit timeoutMs wins over env var", async () => {
    const originalEnv = process.env[PREBUILD_TIMEOUT_ENV];
    process.env[PREBUILD_TIMEOUT_ENV] = "9999";
    try {
      writeFile(dir, "scripts/prebuild-1.ts");
      const spawn = makeMockSpawn(() => ({ exitCode: 0, durationMs: 1 }));
      await runPrebuildScripts({ rootDir: dir, spawn, timeoutMs: 2222 });
      expect(spawn.calls[0].timeoutMs).toBe(2222);
    } finally {
      if (originalEnv === undefined) delete process.env[PREBUILD_TIMEOUT_ENV];
      else process.env[PREBUILD_TIMEOUT_ENV] = originalEnv;
    }
  });

  it("defaultSpawn throws PrebuildTimeoutError with script name + limit when the script runs longer than timeout", async () => {
    // Script sleeps 300ms — we set timeout 80ms, so the timer must win.
    // We use `Bun.sleep` + `process.exit(0)` so the script exits cleanly
    // if somehow the kill is skipped (no zombie in test harness).
    const scriptAbs = writeFile(
      dir,
      "scripts/prebuild-slow.ts",
      "await Bun.sleep(300);\nprocess.exit(0);\n",
    );

    let caught: unknown;
    try {
      await defaultSpawn({ scriptPath: scriptAbs, cwd: dir, timeoutMs: 80 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrebuildTimeoutError);
    expect(caught).toBeInstanceOf(PrebuildError); // subclass relationship
    const err = caught as PrebuildTimeoutError;
    expect(err.timeoutMs).toBe(80);
    expect(err.scriptPath).toContain("prebuild-slow.ts");
    // Message contract: includes script name + timeout limit + override hint.
    expect(err.message).toContain("prebuild-slow.ts");
    expect(err.message).toContain("80ms");
    expect(err.message).toContain("dev.prebuildTimeoutMs");
    expect(err.message).toContain(PREBUILD_TIMEOUT_ENV);
    // Regression beacon: message MUST NOT contain the opaque
    // "non-Error thrown" string Issue #203 was reported against.
    expect(err.message).not.toContain("non-Error thrown");
  });

  it("runPrebuildScripts surfaces PrebuildTimeoutError via injected spawn", async () => {
    writeFile(dir, "scripts/prebuild-slow.ts");
    const spawn: SpawnHook = async (args) => {
      throw new PrebuildTimeoutError({
        scriptPath: args.scriptPath,
        timeoutMs: args.timeoutMs,
        durationMs: args.timeoutMs,
      });
    };
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn, timeoutMs: 100 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrebuildTimeoutError);
    const err = caught as PrebuildTimeoutError;
    expect(err.timeoutMs).toBe(100);
    expect(err.scriptPath).toContain("prebuild-slow.ts");
  });
});

describe("runPrebuildScripts — error preservation (Issue #203)", () => {
  let dir = "";
  beforeEach(() => { dir = mktmp("err-surface-"); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("preserves the inner Error message ('boom') when a spawn rejection occurs", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const inner = new Error("boom");
    const spawn: SpawnHook = async () => {
      throw inner;
    };
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrebuildError);
    const err = caught as PrebuildError & { cause?: unknown };
    // The inner message MUST appear verbatim — the whole point of #203.
    expect(err.message).toContain("boom");
    // Regression beacon.
    expect(err.message).not.toContain("non-Error thrown");
    // The inner error is attached as `.cause` so debug tooling can
    // recover its stack.
    expect(err.cause).toBe(inner);
  });

  it("preserves stack via .cause when inner Error has a stack", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const inner = new Error("kaboom");
    const originalStack = inner.stack;
    expect(originalStack).toBeTruthy();
    const spawn: SpawnHook = async () => {
      throw inner;
    };
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    const err = caught as PrebuildError & { cause?: Error };
    expect(err.cause).toBe(inner);
    expect(err.cause?.stack).toBe(originalStack);
  });

  it("handles non-Error rejections (string) without producing 'non-Error thrown'", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const spawn: SpawnHook = async () => {
      // Raw string throw — the pathological case Issue #203 was about.
      throw "spawn blew up";
    };
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrebuildError);
    const err = caught as PrebuildError & { cause?: unknown };
    // The raw string survives into `.message`.
    expect(err.message).toContain("spawn blew up");
    expect(err.message).not.toContain("non-Error thrown");
    expect(err.cause).toBe("spawn blew up");
  });

  it("handles non-Error rejections (object) without producing 'non-Error thrown'", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const raw = { code: "EBADF", info: "fd closed" };
    const spawn: SpawnHook = async () => {
      throw raw;
    };
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    const err = caught as PrebuildError & { cause?: unknown };
    expect(err.message).toContain("EBADF");
    expect(err.message).not.toContain("non-Error thrown");
    expect(err.cause).toBe(raw);
  });

  it("includes stdout/stderr tails in PrebuildError.message for non-zero exit", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const stderrSample = Array.from({ length: 15 }, (_, i) => `err-line-${i + 1}`).join("\n");
    const stdoutSample = Array.from({ length: 12 }, (_, i) => `out-line-${i + 1}`).join("\n");
    const spawn: SpawnHook = async () => ({
      exitCode: 1,
      durationMs: 5,
      stdoutTail: stdoutSample,
      stderrTail: stderrSample,
    });
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrebuildError);
    const err = caught as PrebuildError;
    // Exactly last 10 stderr lines are kept.
    expect(err.message).toContain("err-line-15");
    expect(err.message).toContain("err-line-6"); // the 10-from-last
    expect(err.message).not.toContain("err-line-5"); // trimmed
    // Stdout tail is also present (10 lines out of 12).
    expect(err.message).toContain("out-line-12");
    expect(err.message).toContain("out-line-3");
    expect(err.message).not.toContain("out-line-2");
    // Structured fields carry the full captured tails.
    expect(err.stderrTail).toBe(stderrSample);
    expect(err.stdoutTail).toBe(stdoutSample);
  });

  it("omits empty tail sections when the spawn hook didn't capture", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const spawn: SpawnHook = async () => ({ exitCode: 2, durationMs: 3 });
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    const err = caught as PrebuildError;
    // The "exited with code 2" prefix is present but no "--- stderr ---" sections.
    expect(err.message).toContain("exited with code 2");
    expect(err.message).not.toContain("--- stderr");
    expect(err.message).not.toContain("--- stdout");
  });

  it("normalizes Windows-style CRLF line endings in stderr tail", async () => {
    writeFile(dir, "scripts/prebuild.ts");
    const crlf = ["a", "b", "c", "d"].join("\r\n");
    const spawn: SpawnHook = async () => ({
      exitCode: 1,
      durationMs: 1,
      stderrTail: crlf,
    });
    let caught: unknown;
    try {
      await runPrebuildScripts({ rootDir: dir, spawn });
    } catch (e) {
      caught = e;
    }
    const err = caught as PrebuildError;
    // All 4 lines survive (under the 10-line cap).
    expect(err.message).toContain("a\nb\nc\nd");
    // No raw \r\n survived.
    expect(err.message).not.toContain("\r\n");
  });
});

describe("PrebuildTimeoutError shape (Issue #203)", () => {
  it("is a subclass of PrebuildError so existing `instanceof PrebuildError` callers still match", () => {
    const err = new PrebuildTimeoutError({
      scriptPath: "/tmp/foo/scripts/prebuild.ts",
      timeoutMs: 500,
      durationMs: 500,
    });
    expect(err).toBeInstanceOf(PrebuildTimeoutError);
    expect(err).toBeInstanceOf(PrebuildError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PrebuildTimeoutError");
    expect(err.exitCode).toBeNull();
  });

  it("message names the script + limit + override paths", () => {
    const err = new PrebuildTimeoutError({
      scriptPath: "/repo/scripts/prebuild-seed.ts",
      timeoutMs: 250,
      durationMs: 250,
    });
    expect(err.message).toContain("prebuild-seed.ts");
    expect(err.message).toContain("250ms");
    expect(err.message).toContain("dev.prebuildTimeoutMs");
    expect(err.message).toContain(PREBUILD_TIMEOUT_ENV);
  });
});

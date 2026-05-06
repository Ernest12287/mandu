/**
 * Verifies the Phase 2 handler split:
 *   - `mandu init` (no positional name)  → invokes retrofit() in cwd
 *   - `mandu init <name>`                → prints deprecation and forwards
 *                                          to the create handler
 *   - `mandu create <name>`              → unchanged scaffold path
 *
 * The create-path test stops short of running the actual scaffold —
 * we only verify dispatch, not the (large, side-effectful) scaffold
 * implementation, which is covered by the legacy init() suite.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getCommand } from "../registry";
import type { CommandContext } from "../registry";

let workDir: string;
let originalCwd: string;
let warnSpy: { calls: string[]; restore: () => void };
let errSpy: { calls: string[]; restore: () => void };
let logSpy: { calls: string[]; restore: () => void };

function spyOnConsole(method: "warn" | "error" | "log") {
  const calls: string[] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    calls.push(args.map((a) => String(a)).join(" "));
  };
  return {
    calls,
    restore: () => {
      console[method] = original;
    },
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "mandu-init-handler-"));
  originalCwd = process.cwd();
  process.chdir(workDir);
  warnSpy = spyOnConsole("warn");
  errSpy = spyOnConsole("error");
  logSpy = spyOnConsole("log");
});

afterEach(async () => {
  warnSpy.restore();
  errSpy.restore();
  logSpy.restore();
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

describe("`mandu init` (no positional) → retrofit", () => {
  test("dry-run writes nothing but reports success", async () => {
    const init = getCommand("init")!;
    const ctx: CommandContext = {
      args: ["init"],
      options: { "dry-run": "true" },
    };
    const success = await init.run(ctx);
    expect(success).toBe(true);
    // Disk untouched.
    await expect(access(path.join(workDir, "package.json"))).rejects.toThrow();
  });

  test("real retrofit on empty cwd writes package.json + app/page.tsx", async () => {
    const init = getCommand("init")!;
    const ctx: CommandContext = { args: ["init"], options: {} };
    const success = await init.run(ctx);
    expect(success).toBe(true);

    const pkgRaw = await readFile(path.join(workDir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    expect(pkg.dependencies["@mandujs/core"]).toBeDefined();
    expect(pkg.scripts.dev).toBe("mandu dev");

    const page = await readFile(
      path.join(workDir, "app", "page.tsx"),
      "utf8"
    );
    expect(page).toContain("Hello from Mandu");
  });

  test("retrofit on a Next.js project aborts gracefully", async () => {
    // Plant a next.config.ts so detect classifies the cwd as
    // nextProject and retrofit refuses.
    await Bun.write(
      path.join(workDir, "next.config.ts"),
      "export default {};"
    );
    await Bun.write(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "x" })
    );

    const init = getCommand("init")!;
    const ctx: CommandContext = { args: ["init"], options: {} };
    const success = await init.run(ctx);
    expect(success).toBe(false);
    // Reason about the foreign framework should reach stderr.
    expect(errSpy.calls.join("\n")).toMatch(/Next\.js/);
  });
});

describe("`mandu init <name>` → deprecation + forward to create", () => {
  test("prints deprecation warning mentioning the new spelling", async () => {
    // Stub the create handler so we don't actually invoke the
    // legacy scaffold (which calls process.exit on success). We
    // capture the ctx that flows through and confirm the warning.
    const create = getCommand("create")!;
    const originalRun = create.run;
    let createCalled = false;
    const captured: { ctx: CommandContext | null } = { ctx: null };
    create.run = async (ctx) => {
      createCalled = true;
      captured.ctx = ctx;
      return true;
    };

    try {
      const init = getCommand("init")!;
      const ctx: CommandContext = {
        args: ["init", "my-app"],
        options: { _positional: "my-app" },
      };
      const success = await init.run(ctx);
      expect(success).toBe(true);
      expect(createCalled).toBe(true);
      expect(captured.ctx).toBe(ctx);

      const warnings = warnSpy.calls.join("\n");
      expect(warnings).toMatch(/deprecated/i);
      expect(warnings).toMatch(/mandu create my-app/);
    } finally {
      create.run = originalRun;
    }
  });

  test("does not invoke retrofit when a positional is provided", async () => {
    const create = getCommand("create")!;
    const originalRun = create.run;
    create.run = async () => true;

    try {
      const init = getCommand("init")!;
      const ctx: CommandContext = {
        args: ["init", "foo"],
        options: { _positional: "foo" },
      };
      await init.run(ctx);
      // package.json must NOT have been written into cwd — that's the
      // retrofit codepath, which we expect was bypassed.
      await expect(
        access(path.join(workDir, "package.json"))
      ).rejects.toThrow();
    } finally {
      create.run = originalRun;
    }
  });
});

describe("`mandu init` exposes --dry-run and --force", () => {
  test("--force overwrites a conflicting react version on a barePackageJson cwd", async () => {
    await Bun.write(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { react: "^18.2.0" } })
    );
    const init = getCommand("init")!;
    const ctx: CommandContext = {
      args: ["init"],
      options: { force: "true" },
    };
    const success = await init.run(ctx);
    expect(success).toBe(true);

    const pkg = JSON.parse(
      await readFile(path.join(workDir, "package.json"), "utf8")
    );
    expect(pkg.dependencies.react).toBe("^19.2.0");
  });

  test("--dry-run on a polyglot+force-required cwd still surfaces the abort", async () => {
    // Polyglot: package.json + app/ already populated (would conflict),
    // and we don't pass --force. Even with --dry-run, the retrofit
    // refuses because the abort decision precedes the dry-run check.
    await Bun.write(
      path.join(workDir, "package.json"),
      JSON.stringify({ name: "x" })
    );
    await Bun.write(
      path.join(workDir, "app", "page.tsx"),
      "export default () => null;"
    );

    const init = getCommand("init")!;
    const ctx: CommandContext = {
      args: ["init"],
      options: { "dry-run": "true" },
    };
    const success = await init.run(ctx);
    expect(success).toBe(false);
    expect(errSpy.calls.join("\n")).toMatch(/--force/);
  });
});

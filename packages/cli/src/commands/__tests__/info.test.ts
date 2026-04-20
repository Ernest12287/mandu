/**
 * CLI `mandu info` command tests.
 *
 * Each test spins up a fresh tmpdir fixture, chdir's into it, runs the
 * command with stdout captured, and asserts shape + content. The command
 * must never crash on a half-scaffolded project (the whole point of
 * `mandu info` is to inspect broken states), so we exercise the
 * "missing config" path explicitly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";

import { info, collectInfo, ALL_SECTIONS } from "../info";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

async function mkRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mandu-info-cli-"));
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

function captureStdout(fn: () => Promise<boolean>): Promise<{ result: boolean; out: string }> {
  const origLog = console.log;
  const origError = console.error;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  return fn()
    .then((result) => ({ result, out }))
    .finally(() => {
      console.log = origLog;
      console.error = origError;
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite
// ═══════════════════════════════════════════════════════════════════════════

describe("mandu info CLI", () => {
  let root: string;
  let origCwd: string;

  beforeEach(async () => {
    root = await mkRoot();
    origCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await fs.rm(root, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Human output: emits all sections + stable section headers
  // ─────────────────────────────────────────────────────────────────────────
  it("renders all eight section headers in human mode", async () => {
    const { result, out } = await captureStdout(() => info({}));
    expect(result).toBe(true);
    expect(out).toMatch(/Mandu Info/);
    expect(out).toMatch(/^mandu$/m);
    expect(out).toMatch(/^runtime$/m);
    expect(out).toMatch(/^project$/m);
    expect(out).toMatch(/^mandu\.config summary$/m);
    expect(out).toMatch(/^routes$/m);
    expect(out).toMatch(/middleware chain/);
    expect(out).toMatch(/^plugins /m);
    expect(out).toMatch(/^diagnose$/m);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. JSON shape: parseable + contains expected top-level keys + envelope
  // ─────────────────────────────────────────────────────────────────────────
  it("emits valid JSON matching the declared schema", async () => {
    const { result, out } = await captureStdout(() => info({ json: true }));
    expect(result).toBe(true);
    const parsed = JSON.parse(out.trim());

    expect(parsed).toHaveProperty("generatedAt");
    expect(typeof parsed.generatedAt).toBe("string");
    expect(Array.isArray(parsed.sections)).toBe(true);
    expect(parsed.sections.length).toBe(ALL_SECTIONS.length);

    // Default invocation includes every section.
    for (const section of ALL_SECTIONS) {
      expect(parsed).toHaveProperty(section);
    }

    // Runtime shape is critical for issue reports.
    expect(typeof parsed.runtime.node).toBe("string");
    expect(typeof parsed.runtime.platform).toBe("string");
    expect(typeof parsed.runtime.cpuCount).toBe("number");
    expect(typeof parsed.runtime.memoryTotalBytes).toBe("number");
    expect(typeof parsed.runtime.nodeEnv).toBe("string");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Missing config is graceful — no crash, reports "(no config)"
  // ─────────────────────────────────────────────────────────────────────────
  it("does not crash when mandu.config.* is absent", async () => {
    const { result, out } = await captureStdout(() => info({}));
    expect(result).toBe(true);
    expect(out).toMatch(/\(no config\)/);
  });

  it("JSON path sets config: null when no config file is present", async () => {
    const { out } = await captureStdout(() => info({ json: true }));
    const parsed = JSON.parse(out.trim());
    expect(parsed.config).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. --include filter whitelists sections
  // ─────────────────────────────────────────────────────────────────────────
  it("--include filter restricts emitted sections (JSON)", async () => {
    const { out } = await captureStdout(() =>
      info({ json: true, include: "mandu,runtime" }),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed).toHaveProperty("mandu");
    expect(parsed).toHaveProperty("runtime");
    expect(parsed).not.toHaveProperty("project");
    expect(parsed).not.toHaveProperty("routes");
    expect(parsed).not.toHaveProperty("diagnose");
    expect(parsed.sections).toEqual(["mandu", "runtime"]);
  });

  it("--include filter restricts emitted sections (human)", async () => {
    const { out } = await captureStdout(() => info({ include: "runtime" }));
    expect(out).toMatch(/^runtime$/m);
    expect(out).not.toMatch(/^diagnose$/m);
    expect(out).not.toMatch(/middleware chain/);
  });

  it("--include falls back to all sections when every entry is unknown", async () => {
    // Protects against a silent "no output" trap from a typo'd section name.
    const { out } = await captureStdout(() =>
      info({ json: true, include: "typo1,typo2" }),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.sections.length).toBe(ALL_SECTIONS.length);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Version fallback — cli/core versions fall back to null rather than
  //    throwing when neither node_modules nor require.resolve works.
  // ─────────────────────────────────────────────────────────────────────────
  it("reports versions (string or null) for every known @mandujs package", async () => {
    const payload = await collectInfo({ include: "mandu" });
    expect(payload.mandu).toBeDefined();
    const m = payload.mandu!;
    for (const key of ["core", "cli", "mcp", "ate", "skills", "edge"] as const) {
      expect(m).toHaveProperty(key);
      const v = m[key];
      // Either a semver string or null — never undefined, never a throw.
      expect(v === null || typeof v === "string").toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Routes section handles "no app/ directory" gracefully
  // ─────────────────────────────────────────────────────────────────────────
  it("reports routes: null when no app/ directory exists", async () => {
    const { out } = await captureStdout(() => info({ json: true, include: "routes" }));
    const parsed = JSON.parse(out.trim());
    expect(parsed.routes).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Config summary parses a realistic mandu.config.json
  // ─────────────────────────────────────────────────────────────────────────
  it("summarizes a realistic mandu.config.json", async () => {
    await writeFile(
      root,
      "mandu.config.json",
      JSON.stringify({
        server: { port: 3333, hostname: "0.0.0.0" },
        guard: { preset: "cqrs" },
        build: {
          prerender: true,
          budget: { maxGzBytes: 250_000, mode: "warning" },
        },
        i18n: { locales: ["en", "ko"], defaultLocale: "en", strategy: "path-prefix" },
        transitions: true,
        prefetch: false,
        spa: true,
      }),
    );

    const { out } = await captureStdout(() => info({ json: true, include: "config" }));
    const parsed = JSON.parse(out.trim());
    expect(parsed.config).toBeTruthy();
    expect(parsed.config.server.port).toBe(3333);
    expect(parsed.config.server.hostname).toBe("0.0.0.0");
    expect(parsed.config.guard.preset).toBe("cqrs");
    expect(parsed.config.build.prerender).toBe(true);
    expect(parsed.config.build.budget.maxGzBytes).toBe(250_000);
    expect(parsed.config.build.budget.mode).toBe("warning");
    expect(parsed.config.i18n.locales).toBe(2);
    expect(parsed.config.i18n.defaultLocale).toBe("en");
    expect(parsed.config.i18n.strategy).toBe("path-prefix");
    expect(parsed.config.transitions).toBe(true);
    expect(parsed.config.prefetch).toBe(false);
    expect(parsed.config.spa).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Section ordering is stable (matters for human scanning + diffs)
  // ─────────────────────────────────────────────────────────────────────────
  it("emits sections in canonical ALL_SECTIONS order (human)", async () => {
    const { out } = await captureStdout(() => info({}));
    const expectedOrder = [
      /^mandu$/m,
      /^runtime$/m,
      /^project$/m,
      /^mandu\.config summary$/m,
      /^routes$/m,
      /middleware chain/,
      /^plugins /m,
      /^diagnose$/m,
    ];
    let lastIndex = -1;
    for (const pattern of expectedOrder) {
      const match = out.match(pattern);
      expect(match).not.toBeNull();
      const idx = match!.index ?? -1;
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Diagnose surface is always present + typed correctly
  // ─────────────────────────────────────────────────────────────────────────
  it("diagnose section is emitted with healthy + checks[] shape", async () => {
    const { out } = await captureStdout(() => info({ json: true, include: "diagnose" }));
    const parsed = JSON.parse(out.trim());
    expect(parsed.diagnose).toBeDefined();
    expect(typeof parsed.diagnose.healthy).toBe("boolean");
    expect(typeof parsed.diagnose.errorCount).toBe("number");
    expect(typeof parsed.diagnose.warningCount).toBe("number");
    expect(Array.isArray(parsed.diagnose.checks)).toBe(true);
    for (const check of parsed.diagnose.checks) {
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.rule).toBe("string");
      expect(typeof check.message).toBe("string");
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. Project info reports package.json name/version when present
  // ─────────────────────────────────────────────────────────────────────────
  it("project section reflects local package.json fields", async () => {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "demo-app",
        version: "1.2.3",
        packageManager: "bun@1.3.12",
      }),
    );
    const { out } = await captureStdout(() => info({ json: true, include: "project" }));
    const parsed = JSON.parse(out.trim());
    expect(parsed.project.name).toBe("demo-app");
    expect(parsed.project.version).toBe("1.2.3");
    expect(parsed.project.packageManager).toBe("bun@1.3.12");
    expect(parsed.project.configFile).toBeNull();
  });
});

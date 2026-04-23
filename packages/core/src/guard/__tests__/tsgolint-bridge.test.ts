/**
 * Mandu Guard — oxlint type-aware bridge tests (Follow-up E).
 *
 * Coverage:
 *   1. extractRuleId — normalizes oxlint's `plugin(rule)` shape.
 *   2. mapOxlintSeverity — oxlint severity vocabulary → Mandu `Severity`.
 *   3. translateDiagnostic — shape + filename resolution.
 *   4. resolveOxlintBinary — returns undefined for missing binaries.
 *   5. runTsgolint — skips gracefully when binary missing.
 *   6. runTsgolint — severity=off short-circuit.
 *   7. runTsgolint — real oxlint invocation (when available) on a
 *      fixture with `const x: any = 1` + JSON round-trip.
 *
 * Fixtures are isolated under `os.tmpdir()` and scrubbed in afterEach.
 * Tests that need a real oxlint binary probe `findRepoOxlint()` and
 * skip themselves with an in-place assertion when the binary isn't
 * available — keeping the suite green on contributors' machines where
 * oxlint may not be installed yet.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  extractRuleId,
  mapOxlintSeverity,
  translateDiagnostic,
  resolveOxlintBinary,
  runTsgolint,
} from "../tsgolint-bridge";

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

async function mkFixtureRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mandu-tsgolint-"));
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
}

/**
 * Locate the repo root so real-binary tests can point the bridge at
 * the already-installed `node_modules/.bin/oxlint` without copying
 * shim files (Bun's bin shims embed lockfile metadata and can't
 * survive a plain `copyFile` onto a test fixture).
 *
 * When the walk-up fails (detached tree / fresh clone without install)
 * the caller gracefully asserts the `oxlint-not-installed` skip path
 * instead, keeping the suite green.
 */
async function findRepoRoot(): Promise<string | undefined> {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const bin = path.join(
      dir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "oxlint.exe" : "oxlint",
    );
    try {
      await fs.access(bin);
      return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("extractRuleId", () => {
  it("normalizes typescript-eslint plugin shape to `typescript/<rule>`", () => {
    expect(extractRuleId("typescript-eslint(no-floating-promises)")).toBe(
      "typescript/no-floating-promises",
    );
    expect(extractRuleId("typescript-eslint(no-explicit-any)")).toBe(
      "typescript/no-explicit-any",
    );
  });

  it("returns bare rule name for eslint / unprefixed codes", () => {
    expect(extractRuleId("no-debugger")).toBe("no-debugger");
    expect(extractRuleId("eslint(no-debugger)")).toBe("no-debugger");
  });

  it("preserves other plugin prefixes verbatim", () => {
    expect(extractRuleId("unicorn(no-array-sort)")).toBe("unicorn/no-array-sort");
  });

  it("returns 'unknown' for empty or undefined codes", () => {
    expect(extractRuleId(undefined)).toBe("unknown");
    expect(extractRuleId("")).toBe("unknown");
  });
});

describe("mapOxlintSeverity", () => {
  it("maps oxlint severity strings to Mandu severities", () => {
    expect(mapOxlintSeverity("error")).toBe("error");
    expect(mapOxlintSeverity("warning")).toBe("warn");
    expect(mapOxlintSeverity("advice")).toBe("info");
  });

  it("defaults unknown / undefined severity to 'warn'", () => {
    expect(mapOxlintSeverity(undefined)).toBe("warn");
    expect(mapOxlintSeverity("unexpected")).toBe("warn");
  });
});

describe("translateDiagnostic", () => {
  it("maps filename / line / column / rule / severity correctly", () => {
    const v = translateDiagnostic(
      {
        message: "Unexpected any.",
        code: "typescript-eslint(no-explicit-any)",
        severity: "error",
        filename: "src/foo.ts",
        labels: [{ span: { offset: 9, length: 3, line: 2, column: 10 } }],
        help: "Use unknown instead.",
        url: "https://oxc.rs/...",
      },
      "/root",
    );
    expect(v.ruleName).toBe("typescript/no-explicit-any");
    expect(v.ruleDescription).toBe("Unexpected any.");
    expect(v.severity).toBe("error");
    expect(v.line).toBe(2);
    expect(v.column).toBe(10);
    expect(v.filePath).toBe(path.join("/root", "src/foo.ts"));
    expect(v.suggestions).toContain("Use unknown instead.");
    expect(v.suggestions.some((s) => s.includes("https://oxc.rs"))).toBe(true);
  });

  it("falls back to line 1 column 1 when labels are missing", () => {
    const v = translateDiagnostic(
      {
        message: "X",
        code: "typescript-eslint(y)",
        severity: "warning",
        filename: "src/y.ts",
      },
      "/root",
    );
    expect(v.line).toBe(1);
    expect(v.column).toBe(1);
    expect(v.severity).toBe("warn");
  });

  it("applies severity override when provided", () => {
    const v = translateDiagnostic(
      {
        message: "X",
        code: "typescript-eslint(y)",
        severity: "warning",
        filename: "src/y.ts",
      },
      "/root",
      "error",
    );
    expect(v.severity).toBe("error");
  });
});

// ────────────────────────────────────────────────────────────────────────
// resolveOxlintBinary
// ────────────────────────────────────────────────────────────────────────

describe("resolveOxlintBinary", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkFixtureRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns undefined when node_modules/.bin/oxlint is absent", async () => {
    const found = await resolveOxlintBinary(root);
    expect(found).toBeUndefined();
  });

  it("returns the resolved path when the binary exists", async () => {
    const binDir = path.join(root, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    const binName = process.platform === "win32" ? "oxlint.exe" : "oxlint";
    await fs.writeFile(path.join(binDir, binName), "");
    const found = await resolveOxlintBinary(root);
    expect(found).toBe(path.join(binDir, binName));
  });
});

// ────────────────────────────────────────────────────────────────────────
// runTsgolint — integration
// ────────────────────────────────────────────────────────────────────────

describe("runTsgolint", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkFixtureRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("skips gracefully when oxlint binary is missing (no throw)", async () => {
    const result = await runTsgolint({ projectRoot: root });
    expect(result.skipped).toBe("oxlint-not-installed");
    expect(result.violations).toEqual([]);
    expect(result.summary.elapsedMs).toBe(0);
    expect(result.summary.filesAnalyzed).toBe(0);
  });

  it("short-circuits when severity is 'off' without touching the filesystem", async () => {
    const result = await runTsgolint({ projectRoot: root, severity: "off" });
    expect(result.skipped).toBe("severity-off");
    expect(result.violations).toEqual([]);
  });

  it("runs oxlint on a real fixture and round-trips an explicit-any violation", async () => {
    const repoRoot = await findRepoRoot();
    if (!repoRoot) {
      // Environment without an installed oxlint — assert the skip
      // reason as a sanity check and bail early. Keeps the suite
      // passing on fresh clones.
      const result = await runTsgolint({ projectRoot: root });
      expect(result.skipped).toBe("oxlint-not-installed");
      return;
    }

    // We anchor `projectRoot` at the repo root so `resolveOxlintBinary()`
    // finds the lockfile-aware bin shim. The fixture lives in an
    // isolated subdir at `<repoRoot>/.tmp-tsgolint-*` and we pass only
    // that file path as `paths`, so oxlint lints just our fixture.
    const fixtureSubdir = `.tmp-tsgolint-fixture-${process.pid}-${Date.now()}`;
    const fixtureDir = path.join(repoRoot, fixtureSubdir);
    await fs.mkdir(fixtureDir, { recursive: true });

    try {
      await writeFile(
        fixtureDir,
        ".oxlintrc.json",
        JSON.stringify({
          rules: { "typescript/no-explicit-any": "error" },
        }),
      );
      await writeFile(
        fixtureDir,
        "bad.ts",
        "const x: any = 1;\nexport { x };\n",
      );

      // Anchor projectRoot at repoRoot so the bin-shim resolves;
      // point paths at the fixture file (absolute path so oxlint
      // honors it regardless of cwd).
      const result = await runTsgolint({
        projectRoot: repoRoot,
        configPath: path.join(fixtureDir, ".oxlintrc.json"),
        paths: [path.join(fixtureDir, "bad.ts")],
      });

      expect(result.skipped).toBeUndefined();
      expect(result.violations.length).toBeGreaterThanOrEqual(1);

      const hit = result.violations.find(
        (v) => v.ruleName === "typescript/no-explicit-any",
      );
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("error");
      expect(hit?.filePath.endsWith("bad.ts")).toBe(true);
      expect(hit?.line).toBeGreaterThan(0);

      expect(result.summary.filesAnalyzed).toBeGreaterThanOrEqual(1);
      expect(result.summary.rulesEnabled).toContain(
        "typescript/no-explicit-any",
      );
      expect(result.summary.elapsedMs).toBeGreaterThan(0);
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("filters diagnostics by the `rules` allowlist when provided", async () => {
    const repoRoot = await findRepoRoot();
    if (!repoRoot) {
      // Skip — same graceful-degradation pattern as above.
      return;
    }

    const fixtureSubdir = `.tmp-tsgolint-filter-${process.pid}-${Date.now()}`;
    const fixtureDir = path.join(repoRoot, fixtureSubdir);
    await fs.mkdir(fixtureDir, { recursive: true });

    try {
      await writeFile(
        fixtureDir,
        ".oxlintrc.json",
        JSON.stringify({
          rules: {
            "typescript/no-explicit-any": "error",
            "no-debugger": "error",
          },
        }),
      );
      await writeFile(
        fixtureDir,
        "mixed.ts",
        "const x: any = 1;\ndebugger;\nexport { x };\n",
      );

      const result = await runTsgolint({
        projectRoot: repoRoot,
        configPath: path.join(fixtureDir, ".oxlintrc.json"),
        paths: [path.join(fixtureDir, "mixed.ts")],
        rules: ["typescript/no-explicit-any"],
      });

      // Only typescript/no-explicit-any should survive the post-filter;
      // `no-debugger` hits oxlint but the bridge drops them.
      for (const v of result.violations) {
        expect(v.ruleName).toBe("typescript/no-explicit-any");
      }
      // diagnosticsReceived counts pre-filter and should exceed
      // post-filter violation count when both rules fired.
      expect(result.summary.diagnosticsReceived).toBeGreaterThanOrEqual(
        result.violations.length,
      );
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

/**
 * Tests for `mandu test --coverage` orchestration (Phase 12.3).
 *
 * Verifies:
 *   - `mergeCoverageOutputs` picks up `coverage/lcov.info` and `.mandu/
 *     coverage/unit.lcov` from the project, and merges with an explicit
 *     E2E lcov path.
 *   - Missing inputs do not crash the merge path; output is `null`.
 *   - `enforceCoverageThreshold` returns true when above target, false
 *     when below.
 *   - `enforceCoverageThreshold` tolerates absent LCOV files.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  mergeCoverageOutputs,
  enforceCoverageThreshold,
} from "../test";

const PREFIX = path.join(os.tmpdir(), "mandu-cli-test-coverage-");

const UNIT_LCOV = `
SF:src/a.ts
DA:1,1
DA:2,0
LF:2
LH:1
end_of_record
`.trim();

const E2E_LCOV = `
SF:src/a.ts
DA:2,3
LF:1
LH:1
end_of_record
SF:src/b.ts
DA:1,1
DA:2,1
LF:2
LH:2
end_of_record
`.trim();

// ═══════════════════════════════════════════════════════════════════════════
// mergeCoverageOutputs
// ═══════════════════════════════════════════════════════════════════════════

describe("mergeCoverageOutputs", () => {
  it("merges `coverage/lcov.info` + explicit e2e lcov into .mandu/coverage/lcov.info", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "merge-");
    try {
      // Bun default location.
      fs.mkdirSync(path.join(dir, "coverage"), { recursive: true });
      fs.writeFileSync(path.join(dir, "coverage", "lcov.info"), UNIT_LCOV);
      // E2E lcov from PW.
      const e2eLcov = path.join(dir, "coverage", "e2e.lcov");
      fs.writeFileSync(e2eLcov, E2E_LCOV);

      const res = await mergeCoverageOutputs({ cwd: dir, e2eLcov });
      expect(res.outputPath).not.toBeNull();
      expect(res.outputPath!).toContain(
        path.join(".mandu", "coverage", "lcov.info"),
      );
      expect(res.files).toBe(2); // a.ts + b.ts
      // File should actually exist on disk.
      expect(fs.existsSync(res.outputPath!)).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("merges without an e2e lcov when coverage was unit-only", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "unit-only-");
    try {
      fs.mkdirSync(path.join(dir, "coverage"), { recursive: true });
      fs.writeFileSync(path.join(dir, "coverage", "lcov.info"), UNIT_LCOV);
      const res = await mergeCoverageOutputs({ cwd: dir, e2eLcov: null });
      expect(res.outputPath).not.toBeNull();
      expect(res.files).toBe(1);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null outputPath when neither source exists", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "neither-");
    try {
      const res = await mergeCoverageOutputs({ cwd: dir, e2eLcov: null });
      expect(res.outputPath).toBeNull();
      expect(res.files).toBe(0);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts .mandu/coverage/unit.lcov as a Bun fallback location", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "fallback-");
    try {
      const fallback = path.join(dir, ".mandu", "coverage");
      fs.mkdirSync(fallback, { recursive: true });
      fs.writeFileSync(path.join(fallback, "unit.lcov"), UNIT_LCOV);
      const res = await mergeCoverageOutputs({ cwd: dir, e2eLcov: null });
      expect(res.outputPath).not.toBeNull();
      expect(res.files).toBe(1);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a pointed-at e2e lcov path when the file is missing", async () => {
    const dir = await fs.promises.mkdtemp(PREFIX + "missing-e2e-");
    try {
      fs.mkdirSync(path.join(dir, "coverage"), { recursive: true });
      fs.writeFileSync(path.join(dir, "coverage", "lcov.info"), UNIT_LCOV);
      const res = await mergeCoverageOutputs({
        cwd: dir,
        e2eLcov: path.join(dir, "does-not-exist.lcov"),
      });
      expect(res.outputPath).not.toBeNull();
      expect(res.files).toBe(1); // unit only
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// enforceCoverageThreshold
// ═══════════════════════════════════════════════════════════════════════════

describe("enforceCoverageThreshold", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.promises.mkdtemp(PREFIX + "threshold-");
  });

  afterAll(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  function writeLcov(name: string, lh: number, lf: number): string {
    const lcovPath = path.join(dir, `${name}.lcov`);
    fs.writeFileSync(
      lcovPath,
      [
        "SF:test.ts",
        ...Array.from({ length: lh }, (_, i) => `DA:${i + 1},1`),
        ...Array.from({ length: lf - lh }, (_, i) => `DA:${i + 1 + lh},0`),
        `LF:${lf}`,
        `LH:${lh}`,
        "end_of_record",
        "",
      ].join("\n"),
    );
    return lcovPath;
  }

  it("returns true when threshold is undefined (no check configured)", () => {
    const lcov = writeLcov("undef", 50, 100);
    expect(enforceCoverageThreshold(lcov, undefined)).toBe(true);
  });

  it("returns true when threshold is zero (disabled)", () => {
    const lcov = writeLcov("zero", 50, 100);
    expect(enforceCoverageThreshold(lcov, 0)).toBe(true);
  });

  it("returns true when coverage meets the threshold exactly", () => {
    const lcov = writeLcov("exact", 80, 100);
    expect(enforceCoverageThreshold(lcov, 80)).toBe(true);
  });

  it("returns true when coverage exceeds the threshold", () => {
    const lcov = writeLcov("over", 95, 100);
    expect(enforceCoverageThreshold(lcov, 80)).toBe(true);
  });

  it("returns false when coverage is below the threshold", () => {
    const lcov = writeLcov("under", 50, 100);
    expect(enforceCoverageThreshold(lcov, 80)).toBe(false);
  });

  it("returns true when the LCOV file does not exist", () => {
    // Missing LCOV → treat as "no data yet", do not fail CI.
    expect(
      enforceCoverageThreshold(path.join(dir, "nope.lcov"), 80),
    ).toBe(true);
  });

  it("returns true when LF=0 (no instrumented lines)", () => {
    const lcov = writeLcov("empty", 0, 0);
    // computed percentage would be NaN / 0 — we treat this as "no data".
    expect(enforceCoverageThreshold(lcov, 80)).toBe(true);
  });
});

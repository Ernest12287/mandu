/**
 * Tests for `packages/ate/src/coverage-merger.ts`.
 *
 * Covers:
 *  - Parser: directives, file boundaries, blank-line tolerance.
 *  - Merge: line/function/branch hit summing, union of keys.
 *  - Serialize: deterministic key ordering, trailing newline.
 *  - `mergeLcovFiles`: file + text inputs, missing-file tolerance.
 *  - `mergeAndWriteLcov`: writes to disk, skips on empty.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseLcov,
  serializeLcov,
  mergeRecords,
  mergeLcovFiles,
  mergeAndWriteLcov,
  writeMergedLcov,
  type LcovFileRecord,
} from "../src/coverage-merger";

const PREFIX = path.join(os.tmpdir(), "mandu-ate-lcov-");

// Fixtures ----------------------------------------------------------------

const UNIT_LCOV = `
TN:unit
SF:src/login.ts
FN:10,loginHandler
FNDA:5,loginHandler
FNF:1
FNH:1
BRDA:12,0,0,3
BRDA:12,0,1,-
BRF:2
BRH:1
DA:10,5
DA:11,5
DA:12,5
LF:3
LH:3
end_of_record
SF:src/util.ts
DA:1,2
DA:2,0
LF:2
LH:1
end_of_record
`.trim();

const E2E_LCOV = `
TN:e2e
SF:src/login.ts
FN:10,loginHandler
FNDA:2,loginHandler
FNF:1
FNH:1
BRDA:12,0,1,4
BRDA:20,0,0,1
BRF:2
BRH:2
DA:10,2
DA:11,2
DA:20,1
LF:3
LH:3
end_of_record
`.trim();

// ═══════════════════════════════════════════════════════════════════════════
// parseLcov
// ═══════════════════════════════════════════════════════════════════════════

describe("parseLcov", () => {
  it("parses a single-record file", () => {
    const records = parseLcov(UNIT_LCOV);
    expect(records).toHaveLength(2);
    const login = records.find((r) => r.sourceFile === "src/login.ts");
    expect(login).toBeDefined();
    expect(login!.lineHits.get(10)).toBe(5);
    expect(login!.functions.get("loginHandler")).toBe(10);
    expect(login!.functionHits.get("loginHandler")).toBe(5);
    expect(login!.branchHits.get("12,0,0")).toBe(3);
    // `-` in original stream → 0
    expect(login!.branchHits.get("12,0,1")).toBe(0);
    expect(login!.testNames.has("unit")).toBe(true);
  });

  it("ignores directives between records", () => {
    const body = "TN:t1\nSF:a.ts\nDA:1,1\nend_of_record\n\n\n\nTN:t2\nSF:b.ts\nDA:1,1\nend_of_record";
    const records = parseLcov(body);
    expect(records).toHaveLength(2);
  });

  it("collapses duplicate SF entries within a single input", () => {
    const body = [
      "SF:same.ts",
      "DA:1,1",
      "end_of_record",
      "SF:same.ts",
      "DA:2,1",
      "end_of_record",
    ].join("\n");
    const records = parseLcov(body);
    expect(records).toHaveLength(1);
    expect(records[0].lineHits.size).toBe(2);
  });

  it("tolerates blank lines and CRLF", () => {
    const body = UNIT_LCOV.split("\n").join("\r\n") + "\r\n\r\n";
    const records = parseLcov(body);
    expect(records).toHaveLength(2);
  });

  it("returns empty array on empty input", () => {
    expect(parseLcov("")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mergeRecords
// ═══════════════════════════════════════════════════════════════════════════

describe("mergeRecords", () => {
  it("sums line hits across overlapping files", () => {
    const unit = parseLcov(UNIT_LCOV);
    const e2e = parseLcov(E2E_LCOV);
    const merged = mergeRecords(unit, e2e);
    const login = merged.find((r) => r.sourceFile === "src/login.ts");
    expect(login).toBeDefined();
    expect(login!.lineHits.get(10)).toBe(5 + 2);
    expect(login!.lineHits.get(20)).toBe(1); // only in e2e
  });

  it("sums function hits and branch hits", () => {
    const merged = mergeRecords(parseLcov(UNIT_LCOV), parseLcov(E2E_LCOV));
    const login = merged.find((r) => r.sourceFile === "src/login.ts")!;
    expect(login.functionHits.get("loginHandler")).toBe(5 + 2);
    expect(login.branchHits.get("12,0,1")).toBe(0 + 4);
  });

  it("preserves files that exist in only one input", () => {
    const merged = mergeRecords(parseLcov(UNIT_LCOV), parseLcov(E2E_LCOV));
    expect(merged.find((r) => r.sourceFile === "src/util.ts")).toBeDefined();
  });

  it("does not mutate inputs (clones on merge)", () => {
    const left = parseLcov(UNIT_LCOV);
    const right = parseLcov(E2E_LCOV);
    const loginHitsLeft = left.find((r) => r.sourceFile === "src/login.ts")!
      .lineHits.get(10);
    mergeRecords(left, right);
    const after = left.find((r) => r.sourceFile === "src/login.ts")!
      .lineHits.get(10);
    expect(after).toBe(loginHitsLeft);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// serializeLcov
// ═══════════════════════════════════════════════════════════════════════════

describe("serializeLcov", () => {
  it("renders a deterministic LCOV body", () => {
    const records = parseLcov(UNIT_LCOV);
    const body = serializeLcov(records);
    // Records sorted alphabetically
    expect(body.indexOf("SF:src/login.ts")).toBeLessThan(
      body.indexOf("SF:src/util.ts"),
    );
    // Ends with a trailing newline
    expect(body.endsWith("\n")).toBe(true);
    // Emits LF/LH summary
    expect(body).toContain("LF:3");
    expect(body).toContain("LH:3");
  });

  it("computes BRH correctly", () => {
    const records = parseLcov(UNIT_LCOV);
    const body = serializeLcov(records);
    // unit has 2 branches (12,0,0=3 and 12,0,1=0), hit=1
    expect(body).toContain("BRF:2");
    expect(body).toContain("BRH:1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mergeLcovFiles
// ═══════════════════════════════════════════════════════════════════════════

describe("mergeLcovFiles", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.promises.mkdtemp(PREFIX);
  });

  afterAll(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("merges multiple text inputs", () => {
    const result = mergeLcovFiles([
      { label: "unit", source: { kind: "text", body: UNIT_LCOV } },
      { label: "e2e", source: { kind: "text", body: E2E_LCOV } },
    ]);
    expect(result.summary.files).toBe(2);
    expect(result.records.has("src/login.ts")).toBe(true);
  });

  it("merges mixed file + text inputs", () => {
    const unitPath = path.join(dir, "unit.lcov");
    fs.writeFileSync(unitPath, UNIT_LCOV);
    const result = mergeLcovFiles([
      { label: "unit", source: { kind: "file", path: unitPath } },
      { label: "e2e", source: { kind: "text", body: E2E_LCOV } },
    ]);
    expect(result.summary.files).toBe(2);
  });

  it("tolerates a missing file input", () => {
    const result = mergeLcovFiles([
      { label: "unit", source: { kind: "text", body: UNIT_LCOV } },
      {
        label: "missing",
        source: { kind: "file", path: path.join(dir, "does-not-exist.lcov") },
      },
    ]);
    expect(result.summary.files).toBe(2); // unit only
  });

  it("returns an empty summary on no inputs", () => {
    const result = mergeLcovFiles([]);
    expect(result.summary.files).toBe(0);
    expect(result.lcov).toBe("");
  });

  it("computes summary fields correctly", () => {
    const result = mergeLcovFiles([
      { label: "unit", source: { kind: "text", body: UNIT_LCOV } },
      { label: "e2e", source: { kind: "text", body: E2E_LCOV } },
    ]);
    // login: lines {10,11,12,20} → LF=4, LH=4 (10/11/12 sum to > 0, 20 = 1)
    // util:  lines {1,2}         → LF=2, LH=1
    expect(result.summary.linesFound).toBe(4 + 2);
    expect(result.summary.linesHit).toBe(4 + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// writeMergedLcov + mergeAndWriteLcov
// ═══════════════════════════════════════════════════════════════════════════

describe("writeMergedLcov", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.promises.mkdtemp(PREFIX + "write-");
  });

  afterAll(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("creates nested parent directories", () => {
    const target = path.join(dir, "nested", "deep", "lcov.info");
    const out = writeMergedLcov(target, "TN:x\nend_of_record\n");
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toContain("TN:x");
  });
});

describe("mergeAndWriteLcov", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await fs.promises.mkdtemp(PREFIX + "project-");
  });

  afterAll(async () => {
    await fs.promises.rm(repo, { recursive: true, force: true });
  });

  it("writes to .mandu/coverage/lcov.info by default", () => {
    const result = mergeAndWriteLcov({
      repoRoot: repo,
      inputs: [{ label: "unit", source: { kind: "text", body: UNIT_LCOV } }],
    });
    expect(result.outputPath).toBeDefined();
    expect(result.outputPath).toContain(
      path.join(".mandu", "coverage", "lcov.info"),
    );
    expect(fs.existsSync(result.outputPath!)).toBe(true);
  });

  it("returns null outputPath when no records", () => {
    const result = mergeAndWriteLcov({ repoRoot: repo, inputs: [] });
    expect(result.outputPath).toBeNull();
    expect(result.summary.files).toBe(0);
  });

  it("supports custom outputPath override", () => {
    const target = path.join(repo, "custom", "merged.lcov");
    const result = mergeAndWriteLcov({
      repoRoot: repo,
      inputs: [{ label: "unit", source: { kind: "text", body: UNIT_LCOV } }],
      outputPath: target,
    });
    expect(result.outputPath).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Round-trip determinism
// ═══════════════════════════════════════════════════════════════════════════

describe("round-trip determinism", () => {
  it("parse → serialize → parse is idempotent in hit counts", () => {
    const first = parseLcov(UNIT_LCOV);
    const body = serializeLcov(first);
    const second = parseLcov(body);

    const originalLogin = first.find((r) => r.sourceFile === "src/login.ts")!;
    const rerunLogin = second.find((r) => r.sourceFile === "src/login.ts")!;
    expect(rerunLogin.lineHits.get(10)).toBe(originalLogin.lineHits.get(10)!);
    expect(rerunLogin.functionHits.get("loginHandler")).toBe(
      originalLogin.functionHits.get("loginHandler")!,
    );
  });

  it("serialize produces stable output for stable input", () => {
    const records: LcovFileRecord[] = parseLcov(UNIT_LCOV);
    const a = serializeLcov(records);
    const b = serializeLcov(records);
    expect(a).toBe(b);
  });
});

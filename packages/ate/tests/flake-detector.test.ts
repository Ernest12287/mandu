/**
 * flake-detector — history append + flake score computation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunHistory,
  computeFlakeScore,
  historyFilePath,
  lastPassedAt,
  pruneHistory,
  readRunHistory,
  summarizeFlakes,
} from "../src/flake-detector";

function seed(
  repoRoot: string,
  specPath: string,
  pattern: ("P" | "F" | "S")[],
) {
  let i = 0;
  for (const ch of pattern) {
    const status = ch === "P" ? "pass" : ch === "F" ? "fail" : "skipped";
    appendRunHistory(repoRoot, {
      specPath,
      runId: `r-${specPath}-${i}`,
      status,
      durationMs: 100,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      graphVersion: "gv1:test",
    });
    i += 1;
  }
}

describe("flake-detector (Phase A.2)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-flake-"));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  test("no history: computeFlakeScore returns 0", () => {
    expect(computeFlakeScore(repoRoot, "tests/e2e/signup.spec.ts")).toBe(0);
    expect(lastPassedAt(repoRoot, "tests/e2e/signup.spec.ts")).toBeNull();
    expect(summarizeFlakes(repoRoot)).toEqual([]);
    expect(existsSync(historyFilePath(repoRoot))).toBe(false);
  });

  test("pure pass PPPPP → flakeScore 0, stable test", () => {
    seed(repoRoot, "tests/pass.test.ts", ["P", "P", "P", "P", "P"]);
    expect(computeFlakeScore(repoRoot, "tests/pass.test.ts")).toBe(0);
    expect(lastPassedAt(repoRoot, "tests/pass.test.ts")).not.toBeNull();
    // minScore=0.1 filters this out.
    expect(summarizeFlakes(repoRoot)).toEqual([]);
  });

  test("pure fail FFFFF → flakeScore 0 (broken, NOT flaky)", () => {
    seed(repoRoot, "tests/broken.test.ts", ["F", "F", "F", "F", "F"]);
    expect(computeFlakeScore(repoRoot, "tests/broken.test.ts")).toBe(0);
    expect(lastPassedAt(repoRoot, "tests/broken.test.ts")).toBeNull();
    expect(summarizeFlakes(repoRoot, { minScore: 0.1 })).toEqual([]);
  });

  test("alternating PFPF → flakeScore = 1.0, summarizeFlakes surfaces it", () => {
    seed(repoRoot, "tests/flaky.test.ts", ["P", "F", "P", "F", "P", "F"]);
    const score = computeFlakeScore(repoRoot, "tests/flaky.test.ts");
    expect(score).toBe(1);

    const summary = summarizeFlakes(repoRoot, { minScore: 0.5 });
    expect(summary).toHaveLength(1);
    expect(summary[0].specPath).toBe("tests/flaky.test.ts");
    expect(summary[0].flakeScore).toBe(1);
    expect(summary[0].lastRuns.length).toBe(6);
    // Last runs reversed (newest first).
    expect(summary[0].lastRuns[0].status).toBe("fail");
    expect(summary[0].lastPassedAt).not.toBeNull();

    // PPPFPFF pattern → 3 transitions / 6 = 0.5
    seed(repoRoot, "tests/medium.test.ts", ["P", "P", "P", "F", "P", "F", "F"]);
    const medium = computeFlakeScore(repoRoot, "tests/medium.test.ts");
    expect(medium).toBeCloseTo(3 / 6, 5);
  });

  test("auto-prune drops entries past the hard cap", () => {
    // Hard cap is normally 10,000 — override via env so the test can
    // exercise the prune path with tens (not thousands) of writes.
    const prev = process.env.MANDU_ATE_HISTORY_CAP;
    process.env.MANDU_ATE_HISTORY_CAP = "50";
    try {
      const specPath = "tests/prune.test.ts";
      for (let i = 0; i < 120; i += 1) {
        appendRunHistory(repoRoot, {
          specPath,
          runId: `r-${i.toString().padStart(3, "0")}`,
          status: i % 2 === 0 ? "pass" : "fail",
          durationMs: 10,
          timestamp: new Date(Date.now() + i).toISOString(),
          graphVersion: "gv1:test",
        });
      }
      pruneHistory(repoRoot);

      const all = readRunHistory(repoRoot);
      expect(all.length).toBeLessThanOrEqual(50);

      // Ensure the file itself respects the cap on disk.
      const text = readFileSync(historyFilePath(repoRoot), "utf8");
      const lineCount = text.split("\n").filter(Boolean).length;
      expect(lineCount).toBeLessThanOrEqual(50);

      // The first (oldest) retained entry should have an id > 50
      // because we dropped the oldest half.
      const firstId = Number.parseInt(all[0].runId.replace(/^r-/, ""), 10);
      expect(firstId).toBeGreaterThanOrEqual(70);
    } finally {
      if (prev === undefined) delete process.env.MANDU_ATE_HISTORY_CAP;
      else process.env.MANDU_ATE_HISTORY_CAP = prev;
    }
  });
});

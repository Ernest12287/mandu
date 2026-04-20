/**
 * artifact-store — write/list/prune cycle.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureArtifactDir,
  writeTextArtifact,
  stageArtifact,
  listArtifactRuns,
  pruneArtifacts,
  resolveArtifactPaths,
  newRunId,
} from "../src/artifact-store";

describe("artifact-store (Phase A.2)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-artifact-"));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    // Clear env override for other tests.
    delete process.env.MANDU_ATE_ARTIFACT_KEEP;
  });

  test("write + stage creates files under .mandu/ate-artifacts/<runId>/", () => {
    const runId = newRunId();
    const dir = ensureArtifactDir(repoRoot, runId);
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain(".mandu");
    expect(dir).toContain("ate-artifacts");

    const domPath = writeTextArtifact(repoRoot, runId, "dom.html", "<html></html>");
    expect(existsSync(domPath)).toBe(true);

    // Stage an external file.
    const sourcePath = join(repoRoot, "external-trace.zip");
    writeFileSync(sourcePath, "PK\x03\x04fake zip");
    const staged = stageArtifact(repoRoot, runId, sourcePath, "trace.zip");
    expect(staged).not.toBeNull();
    expect(existsSync(staged!)).toBe(true);

    const paths = resolveArtifactPaths(repoRoot, runId);
    expect(paths.domPath).toBe(domPath);
    expect(paths.tracePath).toBe(staged);
  });

  test("list returns every run, newest first", () => {
    const runA = newRunId();
    ensureArtifactDir(repoRoot, runA);
    // Sleep 5ms equivalent via utimes manipulation:
    const aDir = join(repoRoot, ".mandu", "ate-artifacts", runA);
    const past = new Date(Date.now() - 10_000);
    utimesSync(aDir, past, past);

    const runB = newRunId();
    ensureArtifactDir(repoRoot, runB);

    const runs = listArtifactRuns(repoRoot);
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe(runB); // newer first
    expect(runs[1].runId).toBe(runA);
  });

  test("prune trims to keep=N, dropping the oldest runs", () => {
    // Create 12 runs with monotonically increasing mtime.
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = `run-${i.toString().padStart(3, "0")}`;
      ids.push(id);
      const dir = ensureArtifactDir(repoRoot, id);
      const when = new Date(Date.now() - (12 - i) * 1000);
      utimesSync(dir, when, when);
    }

    const removed = pruneArtifacts(repoRoot, 5);
    expect(removed.length).toBe(7);
    const remaining = listArtifactRuns(repoRoot);
    expect(remaining.length).toBe(5);
    // The 5 newest (ids 7..11) should remain.
    expect(remaining.map((r) => r.runId).sort()).toEqual(
      ["run-007", "run-008", "run-009", "run-010", "run-011"].sort(),
    );
  });
});

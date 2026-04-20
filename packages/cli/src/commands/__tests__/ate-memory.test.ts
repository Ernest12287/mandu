/**
 * Phase B.2 — `mandu ate memory` CLI tests.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAteCommand } from "../ate";
import { appendMemoryEvent, memoryFilePath } from "@mandujs/ate";

let root: string;
const allRoots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-ate-memory-"));
  allRoots.push(root);
});

afterAll(() => {
  for (const r of allRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("mandu ate memory stats", () => {
  test("reports total + byKind counts", async () => {
    appendMemoryEvent(root, {
      kind: "intent_history",
      timestamp: "2026-04-20T00:00:00.000Z",
      intent: "x",
      agent: "t",
      resulting: { saved: [] },
    });

    // Capture console.log output.
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const ok = await runAteCommand(["memory", "stats"], { repoRoot: root });
      expect(ok).toBe(true);
      const joined = logs.join("\n");
      expect(joined).toContain("total events: 1");
      expect(joined).toContain("intent_history: 1");
    } finally {
      console.log = origLog;
    }
  });

  test("--json emits parseable JSON", async () => {
    appendMemoryEvent(root, {
      kind: "coverage_snapshot",
      timestamp: "2026-04-20T00:00:00.000Z",
      routes: 3,
      withSpec: 1,
      withProperty: 0,
    });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await runAteCommand(["memory", "stats"], { repoRoot: root, json: true });
      const parsed = JSON.parse(logs[0]);
      expect(parsed.total).toBe(1);
      expect(parsed.byKind.coverage_snapshot).toBe(1);
    } finally {
      console.log = origLog;
    }
  });
});

describe("mandu ate memory clear", () => {
  test("deletes .mandu/ate-memory.jsonl", async () => {
    appendMemoryEvent(root, {
      kind: "rejected_spec",
      timestamp: "2026-04-20T00:00:00.000Z",
      specPath: "x.test.ts",
      reason: "r",
    });
    expect(existsSync(memoryFilePath(root))).toBe(true);

    const origLog = console.log;
    console.log = () => {};
    try {
      await runAteCommand(["memory", "clear"], { repoRoot: root });
    } finally {
      console.log = origLog;
    }
    expect(existsSync(memoryFilePath(root))).toBe(false);
  });
});

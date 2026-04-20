/**
 * Phase C.4 — oracle queue tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  appendOracleEntry,
  readOracleEntries,
  findOraclePending,
  setOracleVerdict,
  findOracleEntriesForSpec,
  oracleQueuePath,
  type OracleQueueEntry,
} from "../src/oracle/queue";

function mkPendingEntry(overrides: Partial<OracleQueueEntry>): OracleQueueEntry {
  return {
    assertionId: "sem-aaaa",
    specPath: "tests/demo.spec.ts",
    runId: "run-1",
    claim: "hi",
    artifactPath: "artifacts/a",
    status: "pending",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("oracle queue", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mandu-oracle-"));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("appendOracleEntry creates file + writes JSONL line", () => {
    appendOracleEntry(tmp, mkPendingEntry({}));
    const path = oracleQueuePath(tmp);
    expect(existsSync(path)).toBe(true);
    const txt = readFileSync(path, "utf8");
    expect(txt.trim().split("\n").length).toBe(1);
  });

  test("readOracleEntries parses every valid row, skips malformed", () => {
    const path = oracleQueuePath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [JSON.stringify(mkPendingEntry({ assertionId: "a1" })), "not json", JSON.stringify(mkPendingEntry({ assertionId: "a2" }))].join("\n"),
      "utf8",
    );
    const entries = readOracleEntries(tmp);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.assertionId)).toEqual(["a1", "a2"]);
  });

  test("findOraclePending returns only pending entries, newest first", () => {
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "a1", timestamp: "2026-01-01T00:00:00Z" }));
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "a2", timestamp: "2026-02-01T00:00:00Z", status: "passed", verdict: { judgedBy: "agent", reason: "ok", timestamp: "2026-02-02" } }));
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "a3", timestamp: "2026-03-01T00:00:00Z" }));
    const pending = findOraclePending(tmp);
    expect(pending.length).toBe(2);
    expect(pending[0].assertionId).toBe("a3");
    expect(pending[1].assertionId).toBe("a1");
  });

  test("setOracleVerdict transitions pending rows to passed", () => {
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "verdict-1" }));
    const res = setOracleVerdict(tmp, {
      assertionId: "verdict-1",
      verdict: "pass",
      reason: "looks great",
    });
    expect(res.updated).toBe(1);
    const entries = readOracleEntries(tmp);
    expect(entries[0].status).toBe("passed");
    expect(entries[0].verdict?.judgedBy).toBe("agent");
    expect(entries[0].verdict?.reason).toBe("looks great");
  });

  test("setOracleVerdict transitions all matching pending rows", () => {
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "multi", runId: "r1" }));
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "multi", runId: "r2" }));
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "other", runId: "r3" }));
    const res = setOracleVerdict(tmp, { assertionId: "multi", verdict: "fail", reason: "regress" });
    expect(res.updated).toBe(2);
    const all = readOracleEntries(tmp);
    const multis = all.filter((e) => e.assertionId === "multi");
    expect(multis.every((e) => e.status === "failed")).toBe(true);
    const others = all.filter((e) => e.assertionId === "other");
    expect(others[0].status).toBe("pending");
  });

  test("findOracleEntriesForSpec returns audit trail newest→oldest", () => {
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "s1", specPath: "tests/a.spec.ts", timestamp: "2026-01-01" }));
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "s2", specPath: "tests/b.spec.ts", timestamp: "2026-02-01" }));
    appendOracleEntry(tmp, mkPendingEntry({ assertionId: "s3", specPath: "tests/a.spec.ts", timestamp: "2026-03-01" }));
    const rows = findOracleEntriesForSpec(tmp, "tests/a.spec.ts");
    expect(rows.length).toBe(2);
    expect(rows[0].assertionId).toBe("s3");
  });

  test("setOracleVerdict is a no-op when file missing", () => {
    const res = setOracleVerdict(tmp, { assertionId: "nothing", verdict: "pass", reason: "ok" });
    expect(res.updated).toBe(0);
  });
});

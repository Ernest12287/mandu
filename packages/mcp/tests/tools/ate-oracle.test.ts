/**
 * Oracle-queue MCP tools — pending / verdict / replay.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ateOraclePendingToolDefinitions,
  ateOraclePendingTools,
} from "../../src/tools/ate-oracle-pending";
import {
  ateOracleVerdictToolDefinitions,
  ateOracleVerdictTools,
} from "../../src/tools/ate-oracle-verdict";
import {
  ateOracleReplayToolDefinitions,
  ateOracleReplayTools,
} from "../../src/tools/ate-oracle-replay";
import { appendOracleEntry, type OracleEntry } from "@mandujs/ate";

function mkEntry(overrides: Partial<OracleEntry>): OracleEntry {
  return {
    assertionId: "sem-abc",
    specPath: "tests/demo.spec.ts",
    runId: "r1",
    claim: "claim",
    artifactPath: "art/",
    status: "pending",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("oracle MCP tool definitions", () => {
  test("all three tools registered with snake_case names", () => {
    expect(ateOraclePendingToolDefinitions[0].name).toBe("mandu_ate_oracle_pending");
    expect(ateOracleVerdictToolDefinitions[0].name).toBe("mandu_ate_oracle_verdict");
    expect(ateOracleReplayToolDefinitions[0].name).toBe("mandu_ate_oracle_replay");
  });
});

describe("mandu_ate_oracle_pending", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mandu-oracle-mcp-"));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("returns only pending entries", async () => {
    appendOracleEntry(tmp, mkEntry({ assertionId: "p1" }));
    appendOracleEntry(tmp, mkEntry({ assertionId: "p2", status: "passed", verdict: { judgedBy: "agent", reason: "ok", timestamp: "2026-01-01" } }));
    const h = ateOraclePendingTools(tmp);
    const r = (await h.mandu_ate_oracle_pending({ repoRoot: tmp })) as { ok: boolean; count: number; entries: OracleEntry[] };
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    expect(r.entries[0].assertionId).toBe("p1");
  });

  test("rejects missing repoRoot", async () => {
    const h = ateOraclePendingTools(tmp);
    const r = (await h.mandu_ate_oracle_pending({})) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});

describe("mandu_ate_oracle_verdict", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mandu-oracle-verdict-"));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("transitions a pending row to passed", async () => {
    appendOracleEntry(tmp, mkEntry({ assertionId: "v1" }));
    const h = ateOracleVerdictTools(tmp);
    const r = (await h.mandu_ate_oracle_verdict({
      repoRoot: tmp,
      assertionId: "v1",
      verdict: "pass",
      reason: "ui matches claim",
    })) as { ok: boolean; updated: number };
    expect(r.ok).toBe(true);
    expect(r.updated).toBe(1);
  });

  test("rejects invalid verdict value", async () => {
    const h = ateOracleVerdictTools(tmp);
    const r = (await h.mandu_ate_oracle_verdict({
      repoRoot: tmp,
      assertionId: "x",
      verdict: "maybe",
      reason: "unclear",
    })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});

describe("mandu_ate_oracle_replay", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mandu-oracle-replay-"));
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("returns audit trail filtered by spec path", async () => {
    appendOracleEntry(tmp, mkEntry({ assertionId: "a", specPath: "tests/a.spec.ts", timestamp: "2026-01" }));
    appendOracleEntry(tmp, mkEntry({ assertionId: "b", specPath: "tests/b.spec.ts" }));
    appendOracleEntry(tmp, mkEntry({ assertionId: "c", specPath: "tests/a.spec.ts", timestamp: "2026-03" }));
    const h = ateOracleReplayTools(tmp);
    const r = (await h.mandu_ate_oracle_replay({
      repoRoot: tmp,
      specPath: "tests/a.spec.ts",
    })) as { ok: boolean; count: number; entries: OracleEntry[] };
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    // newest first
    expect(r.entries[0].assertionId).toBe("c");
  });

  test("rejects missing specPath", async () => {
    const h = ateOracleReplayTools(tmp);
    const r = (await h.mandu_ate_oracle_replay({ repoRoot: tmp })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});

/**
 * Phase C.4 — oracle queue (append-only JSONL).
 *
 * Lives at `.mandu/ate-oracle-queue.jsonl`. Each line is one
 * `OracleQueueEntry`. The queue is populated by `expectSemantic`
 * (shipped in `@mandujs/core/testing`); verdicts are applied by the
 * `mandu_ate_oracle_verdict` MCP tool.
 *
 * Semantics:
 *   - append-only — setting a verdict REWRITES the whole file so the
 *     matched entry now carries `status = "passed" | "failed"` + the
 *     verdict metadata. Corrupt lines are preserved as-is so we don't
 *     accidentally delete data we don't understand.
 *   - pending entries may appear repeatedly (one per run) — we treat
 *     each line as a distinct audit row. `mandu_ate_oracle_verdict`
 *     sets every matching pending row to the verdict.
 *
 * Spec: docs/ate/phase-c-spec.md §C.4.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type OracleStatus = "pending" | "passed" | "failed";

export interface OracleVerdict {
  judgedBy: "agent" | "human";
  reason: string;
  timestamp: string;
}

export interface OracleQueueEntry {
  assertionId: string;
  specPath: string;
  runId: string;
  claim: string;
  artifactPath: string;
  status: OracleStatus;
  verdict?: OracleVerdict;
  timestamp: string;
}

export function oracleQueuePath(repoRoot: string): string {
  return join(repoRoot, ".mandu", "ate-oracle-queue.jsonl");
}

export function appendOracleEntry(repoRoot: string, entry: OracleQueueEntry): void {
  const path = oracleQueuePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function readOracleEntries(repoRoot: string): OracleQueueEntry[] {
  const path = oracleQueuePath(repoRoot);
  if (!existsSync(path)) return [];
  const content = safeRead(path);
  const out: OracleQueueEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as OracleQueueEntry;
      if (isValidEntry(parsed)) out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isValidEntry(e: unknown): e is OracleQueueEntry {
  if (!e || typeof e !== "object") return false;
  const obj = e as Record<string, unknown>;
  return (
    typeof obj.assertionId === "string" &&
    typeof obj.specPath === "string" &&
    typeof obj.runId === "string" &&
    typeof obj.claim === "string" &&
    typeof obj.artifactPath === "string" &&
    (obj.status === "pending" || obj.status === "passed" || obj.status === "failed")
  );
}

export interface FindPendingOptions {
  limit?: number;
  /** Only return entries touching this spec path. */
  specPath?: string;
}

/**
 * Return the pending tail of the queue — most recent first.
 */
export function findOraclePending(
  repoRoot: string,
  options: FindPendingOptions = {},
): OracleQueueEntry[] {
  const all = readOracleEntries(repoRoot).filter((e) => e.status === "pending");
  const scoped = options.specPath ? all.filter((e) => e.specPath === options.specPath) : all;
  scoped.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const limit = options.limit ?? 20;
  return scoped.slice(0, limit);
}

export interface SetVerdictInput {
  assertionId: string;
  verdict: "pass" | "fail";
  reason: string;
  /** Defaults to "agent". */
  judgedBy?: "agent" | "human";
  /** Inject a timestamp for tests. */
  now?: () => string;
}

export interface SetVerdictResult {
  updated: number;
  entries: OracleQueueEntry[];
}

/**
 * Apply a verdict to every pending entry with `assertionId`. Rewrites
 * the JSONL with the updated rows in place, preserving non-matching
 * rows verbatim.
 */
export function setOracleVerdict(
  repoRoot: string,
  input: SetVerdictInput,
): SetVerdictResult {
  const path = oracleQueuePath(repoRoot);
  if (!existsSync(path)) {
    return { updated: 0, entries: [] };
  }
  const content = safeRead(path);
  const lines = content.split("\n");
  const now = input.now ? input.now() : new Date().toISOString();
  const newStatus: OracleStatus = input.verdict === "pass" ? "passed" : "failed";
  const newVerdict: OracleVerdict = {
    judgedBy: input.judgedBy ?? "agent",
    reason: input.reason,
    timestamp: now,
  };

  const updatedEntries: OracleQueueEntry[] = [];
  let updated = 0;
  const out: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    try {
      const parsed = JSON.parse(line) as OracleQueueEntry;
      if (isValidEntry(parsed) && parsed.assertionId === input.assertionId && parsed.status === "pending") {
        const next: OracleQueueEntry = {
          ...parsed,
          status: newStatus,
          verdict: newVerdict,
        };
        out.push(JSON.stringify(next));
        updatedEntries.push(next);
        updated++;
      } else {
        out.push(line);
      }
    } catch {
      // preserve malformed row as-is
      out.push(line);
    }
  }

  writeFileSync(path, out.join("\n"), "utf8");
  return { updated, entries: updatedEntries };
}

/**
 * Return every queue entry (pending + judged) for a specific spec —
 * used by `mandu_ate_oracle_replay` to surface past verdicts.
 */
export function findOracleEntriesForSpec(
  repoRoot: string,
  specPath: string,
): OracleQueueEntry[] {
  const all = readOracleEntries(repoRoot);
  return all.filter((e) => e.specPath === specPath).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

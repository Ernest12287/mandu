#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_FILE = "packages/core/tests/resource/db-migration-e2e.test.ts";

const MYSQL_URL = process.env.DB_TEST_MYSQL_URL?.trim() ?? "";
const PER_TEST_TIMEOUT_MS = Number(process.env.MANDU_MYSQL_E2E_TIMEOUT_MS ?? 45_000);
const PASS_EXIT_GRACE_MS = Number(process.env.MANDU_MYSQL_E2E_PASS_GRACE_MS ?? 1_000);

interface Case {
  label: string;
  pattern: string;
  expected: string;
  repoScan?: boolean;
}

const CASES: Case[] = [
  {
    label: "create table",
    pattern: "empty applied state",
    expected: "[MySQL] resource → migration → apply > 1. empty applied state + one resource → create-table change applies cleanly",
  },
  {
    label: "add column",
    pattern: "baseline applied → resource adds field",
    expected: "[MySQL] resource → migration → apply > 2. baseline applied → resource adds field → add-column change applies",
  },
  {
    label: "drop column",
    pattern: "baseline applied → resource drops a field",
    expected: "[MySQL] resource → migration → apply > 3. baseline applied → resource drops a field → drop-column change applies",
  },
  {
    label: "explicit index",
    pattern: "explicit persistence.indexes entry",
    expected: "[MySQL] resource → migration → apply > 4a. explicit persistence.indexes entry → add-index change applies",
  },
  {
    label: "indexed add-column",
    pattern: "indexed:true on a newly added field",
    expected: "[MySQL] resource → migration → apply > 4b. indexed:true on a newly added field creates the auto index",
  },
  {
    label: "type-change stub",
    pattern: "type change emits stub migration",
    expected: "[MySQL] resource → migration → apply > 5. type change emits stub migration that applies without error (no-op SELECT 1)",
  },
  {
    label: "generated repo CRUD",
    pattern: "generated repo: create",
    expected: "[MySQL] resource → migration → apply > 6. generated repo: create / findById / findMany / update / delete roundtrip",
  },
  {
    label: "tamper detection",
    pattern: "modifying an applied migration file",
    expected: "[MySQL] resource → migration → apply > 7. modifying an applied migration file is detected as tampered on next run",
    repoScan: true,
  },
  {
    label: "concurrent runners",
    pattern: "two concurrent runners",
    expected: "[MySQL] resource → migration → apply > 8. two concurrent runners: exactly one history row is written",
  },
  {
    label: "empty diff",
    pattern: "identical applied",
    expected: "[MySQL] resource → migration → apply > 9. identical applied + next snapshots → plan is empty, no migration written",
  },
  {
    label: "multi-resource migration",
    pattern: "three new resources",
    expected: "[MySQL] resource → migration → apply > 10. three new resources → one migration file, three CREATE TABLE statements",
  },
  {
    label: "mysql generated SQL shape",
    pattern: "generated create uses LAST_INSERT_ID",
    expected: "[MySQL] dialect-specific assertions > generated create uses LAST_INSERT_ID() follow-up SELECT (no RETURNING)",
  },
];

if (!MYSQL_URL) {
  console.log("MySQL resource e2e: skipped because DB_TEST_MYSQL_URL is not set.");
  process.exit(0);
}

let failed = 0;

for (const testCase of CASES) {
  const result = await runCase(testCase);
  if (!result.ok) {
    failed += 1;
    console.error(`\nFAIL MySQL resource e2e failed: ${testCase.label}`);
    console.error(result.output.trimEnd());
    continue;
  }

  const suffix = result.timedOut
    ? "passed; isolated runner terminated post-pass Bun.SQL MySQL cleanup"
    : "passed";
  console.log(`PASS ${testCase.label}: ${suffix}`);
}

if (failed > 0) {
  console.error(`\nMySQL resource e2e: ${failed}/${CASES.length} case(s) failed.`);
  process.exit(1);
}

console.log(`\nMySQL resource e2e: ${CASES.length} isolated case(s) passed.`);

async function runCase(testCase: Case): Promise<{
  ok: boolean;
  output: string;
  timedOut: boolean;
}> {
  const args = testCase.repoScan
    ? ["bun", "test", "-t", testCase.pattern]
    : ["bun", "test", TEST_FILE, "-t", testCase.pattern];
  const proc = Bun.spawn(args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_TEST_POSTGRES_URL: "",
      DB_TEST_MYSQL_URL: MYSQL_URL,
      MANDU_E2E_ONLY_PROVIDER: "mysql",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  let timedOut = false;
  let exited = false;
  let passGrace: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, PER_TEST_TIMEOUT_MS);

  const onChunk = (chunk: string) => {
    output += chunk;
    if (passGrace || !output.includes(`(pass) ${testCase.expected}`)) return;
    passGrace = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      proc.kill();
    }, PASS_EXIT_GRACE_MS);
  };

  const readers = Promise.all([
    consumeStream(proc.stdout, onChunk),
    consumeStream(proc.stderr, onChunk),
  ]);
  const exitCode = await proc.exited;
  exited = true;
  clearTimeout(timeout);
  if (passGrace) clearTimeout(passGrace);
  await readers;

  const passedExpectedCase = output.includes(`(pass) ${testCase.expected}`);
  const hasFailure = output.includes("(fail)") || output.includes("# Unhandled error");

  if (exitCode === 0 && passedExpectedCase && !hasFailure) {
    return { ok: true, output, timedOut: false };
  }

  if (timedOut && passedExpectedCase && !hasFailure) {
    return { ok: true, output, timedOut: true };
  }

  return { ok: false, output, timedOut };
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}

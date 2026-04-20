/**
 * Phase C.2 — runner + report integration tests.
 *
 * We inject a fake `spawn` so no real child process ever runs. This keeps
 * the test suite hermetic and fast.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMutations, resolveTestCommand, type SpawnFn } from "../src/mutation/runner";
import { computeMutationReport, loadLastMutationRun } from "../src/mutation/report";

const SAMPLE = `import { z } from "zod";
export const Contract = z.object({
  email: z.string().email(),
  count: z.number().int(),
  role: z.enum(["user", "admin"]),
});

export async function handle(req: Request) {
  const body = await req.json();
  return Response.json(Contract.parse(body));
}
`;

describe("runMutations", () => {
  let tmp: string;
  let target: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mandu-mut-run-"));
    target = join(tmp, "contract.ts");
    writeFileSync(target, SAMPLE, "utf8");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("classifies killed / survived via spawn exit codes", async () => {
    // Every mutation is "killed" (test suite returns non-zero).
    const spawn: SpawnFn = async () => ({ exitCode: 1, output: "fail", timedOut: false });
    const r = await runMutations({
      repoRoot: tmp,
      targetFile: "contract.ts",
      testCommand: ["echo", "test"],
      spawn,
      maxMutations: 10,
      concurrency: 2,
    });
    expect(r.totalExecuted).toBeGreaterThan(0);
    expect(r.results.every((res) => res.status === "killed")).toBe(true);
  });

  test("classifies survived when exit code is 0", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 0, output: "ok", timedOut: false });
    const r = await runMutations({
      repoRoot: tmp,
      targetFile: "contract.ts",
      testCommand: ["echo", "test"],
      spawn,
      maxMutations: 5,
    });
    expect(r.results.every((res) => res.status === "survived")).toBe(true);
  });

  test("classifies timeout when spawn reports timedOut", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: -1, output: "abort", timedOut: true });
    const r = await runMutations({
      repoRoot: tmp,
      targetFile: "contract.ts",
      testCommand: ["echo", "test"],
      spawn,
      maxMutations: 3,
    });
    expect(r.results.every((res) => res.status === "timeout")).toBe(true);
  });

  test("restores the original file contents after the run", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 0, output: "", timedOut: false });
    await runMutations({
      repoRoot: tmp,
      targetFile: "contract.ts",
      testCommand: ["echo", "test"],
      spawn,
      maxMutations: 5,
    });
    expect(readFileSync(target, "utf8")).toBe(SAMPLE);
  });

  test("persists a last-run.json with all results", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 1, output: "", timedOut: false });
    const r = await runMutations({
      repoRoot: tmp,
      targetFile: "contract.ts",
      testCommand: ["echo", "test"],
      spawn,
      maxMutations: 3,
    });
    expect(existsSync(r.reportPath)).toBe(true);
    const loaded = loadLastMutationRun(tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.results.length).toBe(r.results.length);
  });
});

describe("resolveTestCommand", () => {
  test("falls back to target directory when no spec index matches", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mandu-mut-resolve-"));
    try {
      const dir = join(tmp, "app", "api", "ping");
      mkdirSync(dir, { recursive: true });
      const f = join(dir, "route.ts");
      writeFileSync(f, "export default () => {};");
      const cmd = resolveTestCommand(tmp, f);
      expect(cmd[0]).toBe("bun");
      expect(cmd[1]).toBe("test");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

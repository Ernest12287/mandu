/**
 * runSpec — translated-failure round-trip tests.
 *
 * We inject a stub `exec` into `runSpec` so these tests never actually
 * fork a subprocess. Each scenario exercises one path of the failure
 * classifier + artifact pipeline.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpec } from "../src/run";
import type { RunnerExec, RunnerExecResult } from "../src/run";
import { failureV1Schema } from "../schemas/failure.v1";
import { listArtifactRuns } from "../src/artifact-store";

function makeExec(result: Partial<RunnerExecResult> & { exitCode: number }): RunnerExec {
  return async () => ({
    stdout: "",
    stderr: "",
    durationMs: 12,
    ...result,
  });
}

describe("runSpec (Phase A.2)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-run-"));
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  test("pass path: exit 0 yields PassResult with graphVersion", async () => {
    const result = await runSpec({
      repoRoot,
      spec: "tests/unit/handler.test.ts",
      exec: makeExec({ exitCode: 0, stdout: "3 pass\n" }),
    });
    expect(result.status).toBe("pass");
    if (result.status !== "pass") throw new Error("unreachable");
    expect(result.assertions).toBe(3);
    expect(result.runner).toBe("bun");
    expect(result.graphVersion).toMatch(/^gv1:/);
    expect(result.runId).toBeTruthy();
  });

  test("selector_drift: default classification on unmatched stderr", async () => {
    const result = await runSpec({
      repoRoot,
      spec: "tests/e2e/signup.spec.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: `Error: locator("[data-testid=submit]") not found`,
      }),
    });
    expect(result.status).toBe("fail");
    if (result.status !== "fail") throw new Error("unreachable");
    expect(result.kind).toBe("selector_drift");
    expect(failureV1Schema.safeParse(result).success).toBe(true);
    // Artifacts staged.
    expect(result.trace.dom).toBeTruthy();
    expect(existsSync(result.trace.dom!)).toBe(true);
  });

  test("contract_mismatch + csrf_invalid + rate_limit + hydration_timeout classifications", async () => {
    // contract_mismatch
    const contract = await runSpec({
      repoRoot,
      spec: "tests/unit/signup.test.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: "contract_violation: route /api/signup expected string received number",
      }),
    });
    if (contract.status !== "fail") throw new Error("unreachable");
    expect(contract.kind).toBe("contract_mismatch");
    expect(contract.healing.requires_llm).toBe(true);

    // csrf_invalid
    const csrf = await runSpec({
      repoRoot,
      spec: "tests/unit/csrf.test.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: "POST /api/signup 403 csrf token missing",
      }),
    });
    if (csrf.status !== "fail") throw new Error("unreachable");
    expect(csrf.kind).toBe("csrf_invalid");

    // rate_limit
    const rate = await runSpec({
      repoRoot,
      spec: "tests/unit/rate.test.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: "POST /api/signup 429 rate limit exceeded",
      }),
    });
    if (rate.status !== "fail") throw new Error("unreachable");
    expect(rate.kind).toBe("rate_limit_exceeded");

    // hydration_timeout
    const hyd = await runSpec({
      repoRoot,
      spec: "tests/e2e/island.spec.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: 'hydration timeout: island "counter" exceeded 5000 ms',
      }),
    });
    if (hyd.status !== "fail") throw new Error("unreachable");
    expect(hyd.kind).toBe("hydration_timeout");
  });

  test("redirect_unexpected + fixture_missing + semantic_divergence classifications", async () => {
    const redirect = await runSpec({
      repoRoot,
      spec: "tests/e2e/redirect.spec.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: "unexpected redirect from /dashboard to /login",
      }),
    });
    if (redirect.status !== "fail") throw new Error("unreachable");
    expect(redirect.kind).toBe("redirect_unexpected");

    const fixture = await runSpec({
      repoRoot,
      spec: "tests/unit/signup.test.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: "fixture createTestDb not found",
      }),
    });
    if (fixture.status !== "fail") throw new Error("unreachable");
    expect(fixture.kind).toBe("fixture_missing");

    const semantic = await runSpec({
      repoRoot,
      spec: "tests/e2e/semantic.spec.ts",
      exec: makeExec({
        exitCode: 1,
        stderr: 'expectSemantic failed claim: "signup form is visible"',
      }),
    });
    if (semantic.status !== "fail") throw new Error("unreachable");
    expect(semantic.kind).toBe("semantic_divergence");
    expect(semantic.healing.requires_llm).toBe(true);
  });

  test("shard passthrough: Playwright gets --shard=c/t", async () => {
    let capturedArgs: string[] | null = null;
    const result = await runSpec({
      repoRoot,
      spec: "tests/e2e/signup.spec.ts",
      shard: { current: 2, total: 4 },
      exec: async (input) => {
        capturedArgs = input.args;
        expect(input.runner).toBe("playwright");
        return { exitCode: 0, stdout: "1 pass\n", stderr: "", durationMs: 5 };
      },
    });
    expect(result.status).toBe("pass");
    expect(capturedArgs).toContain("--shard=2/4");

    // bun shard via env vars.
    let capturedEnv: NodeJS.ProcessEnv | null = null;
    await runSpec({
      repoRoot,
      spec: "tests/unit/handler.test.ts",
      shard: { current: 1, total: 3 },
      exec: async (input) => {
        capturedEnv = input.env;
        return { exitCode: 0, stdout: "1 pass\n", stderr: "", durationMs: 5 };
      },
    });
    expect(capturedEnv?.MANDU_ATE_SHARD_CURRENT).toBe("1");
    expect(capturedEnv?.MANDU_ATE_SHARD_TOTAL).toBe("3");
  });

  test("artifact emission: failure writes dom.html into .mandu/ate-artifacts/<runId>/", async () => {
    const result = await runSpec({
      repoRoot,
      spec: "tests/e2e/signup.spec.ts",
      runId: "fixed-run-id",
      exec: makeExec({
        exitCode: 1,
        stdout: "oh no",
        stderr: 'locator("[data-testid=submit]") not found',
      }),
    });
    expect(result.status).toBe("fail");
    if (result.status !== "fail") throw new Error("unreachable");

    // dom artifact always written.
    expect(result.trace.dom).toBeTruthy();
    const domContent = readFileSync(result.trace.dom!, "utf8");
    expect(domContent).toContain("oh no");
    expect(domContent).toContain("[data-testid=submit]");

    // Listing shows exactly one run.
    const runs = listArtifactRuns(repoRoot);
    expect(runs.length).toBe(1);
    expect(runs[0].runId).toBe("fixed-run-id");
  });
});

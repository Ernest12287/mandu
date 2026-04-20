/**
 * `mandu_ate_mutate` + `mandu_ate_mutation_report` MCP surface tests.
 *
 * We use an injected spawn path via the underlying `runMutations` when
 * possible; where MCP doesn't expose that seam, we run against a tiny
 * tmp project.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ateMutateToolDefinitions,
  ateMutateTools,
} from "../../src/tools/ate-mutate";
import {
  ateMutationReportToolDefinitions,
  ateMutationReportTools,
} from "../../src/tools/ate-mutation-report";
import { runMutations } from "@mandujs/ate";

const SAMPLE = `import { z } from "zod";
export const C = z.object({ email: z.string().email() });
`;

describe("mandu_ate_mutate tool", () => {
  test("tool definition schema", () => {
    expect(ateMutateToolDefinitions).toHaveLength(1);
    const def = ateMutateToolDefinitions[0];
    expect(def.name).toBe("mandu_ate_mutate");
    expect(def.name).toMatch(/^mandu_ate_[a-z_]+$/);
  });

  test("handler rejects missing repoRoot", async () => {
    const handlers = ateMutateTools(process.cwd());
    const r = (await handlers.mandu_ate_mutate({ targetFile: "x.ts" })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  test("handler rejects missing targetFile", async () => {
    const handlers = ateMutateTools(process.cwd());
    const r = (await handlers.mandu_ate_mutate({ repoRoot: process.cwd() })) as { ok: boolean };
    expect(r.ok).toBe(false);
  });
});

describe("mandu_ate_mutation_report tool", () => {
  let tmp: string;
  let target: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mandu-mcp-mut-"));
    target = join(tmp, "contract.ts");
    writeFileSync(target, SAMPLE, "utf8");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("tool definition schema", () => {
    expect(ateMutationReportToolDefinitions).toHaveLength(1);
    const def = ateMutationReportToolDefinitions[0];
    expect(def.name).toBe("mandu_ate_mutation_report");
  });

  test("returns error when no prior run exists", async () => {
    const handlers = ateMutationReportTools(tmp);
    const r = (await handlers.mandu_ate_mutation_report({ repoRoot: tmp })) as {
      ok: boolean;
      error?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("No mutation run");
  });

  test("round-trips a runMutations result through the report", async () => {
    await runMutations({
      repoRoot: tmp,
      targetFile: "contract.ts",
      testCommand: ["echo", "x"],
      spawn: async () => ({ exitCode: 1, output: "", timedOut: false }),
      maxMutations: 3,
    });
    const handlers = ateMutationReportTools(tmp);
    const r = (await handlers.mandu_ate_mutation_report({ repoRoot: tmp })) as {
      ok: boolean;
      report?: { mutationScore: number };
    };
    expect(r.ok).toBe(true);
    expect(typeof r.report?.mutationScore).toBe("number");
  });
});

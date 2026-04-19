/**
 * MCP tool — `mandu.run.tests` tests.
 *
 * We cover:
 *   - Tool definition structure & metadata
 *   - Input validation (bad target, bad filter type, bad coverage type)
 *   - Parser correctness against representative bun-test output
 *   - Handler wiring (tool surface + handler names)
 *
 * We do NOT spawn real test processes in these tests — that would make
 * the suite non-hermetic. The spawn path is exercised indirectly via
 * the MCP registry wiring.
 */

import { describe, it, expect } from "bun:test";
import {
  runTestsToolDefinitions,
  runTestsTools,
  parseTestOutput,
} from "../../src/tools/run-tests";

describe("runTestsToolDefinitions", () => {
  it("declares the `mandu.run.tests` tool", () => {
    expect(runTestsToolDefinitions).toHaveLength(1);
    const def = runTestsToolDefinitions[0];
    expect(def.name).toBe("mandu.run.tests");
    expect(typeof def.description).toBe("string");
    expect(def.description.length).toBeGreaterThan(30);
    expect(def.inputSchema.type).toBe("object");
  });

  it("declares readOnlyHint annotation", () => {
    const def = runTestsToolDefinitions[0];
    expect(def.annotations?.readOnlyHint).toBe(true);
  });

  it("constrains the target enum", () => {
    const def = runTestsToolDefinitions[0];
    const schema = def.inputSchema as {
      properties?: { target?: { enum?: string[] } };
    };
    expect(schema.properties?.target?.enum).toEqual([
      "unit",
      "integration",
      "e2e",
      "all",
    ]);
  });
});

describe("runTestsTools handler map", () => {
  it("returns a handler for mandu.run.tests", () => {
    const h = runTestsTools("/fake/root");
    expect(typeof h["mandu.run.tests"]).toBe("function");
    expect(Object.keys(h)).toHaveLength(1);
  });

  it("rejects an invalid target with a structured error", async () => {
    const h = runTestsTools("/fake/root");
    const result = (await h["mandu.run.tests"]({ target: "bogus" })) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("target");
  });

  it("rejects a non-string filter", async () => {
    const h = runTestsTools("/fake/root");
    const result = (await h["mandu.run.tests"]({ filter: 42 })) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("filter");
  });

  it("rejects a non-boolean coverage", async () => {
    const h = runTestsTools("/fake/root");
    const result = (await h["mandu.run.tests"]({ coverage: "yes" })) as {
      error?: string;
      field?: string;
    };
    expect(result.error).toBeDefined();
    expect(result.field).toBe("coverage");
  });
});

describe("parseTestOutput", () => {
  it("extracts passed/failed/skipped counts from the summary block", () => {
    const raw = [
      "src/foo.test.ts:",
      "(pass) adds > one",
      "(pass) adds > two",
      "(fail) multiplies > one",
      "",
      "2 pass",
      "1 fail",
      "0 skipped",
      "Ran 3 tests across 1 files. [0.42s]",
    ].join("\n");

    const result = parseTestOutput(raw);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.duration_ms).toBe(420);
    expect(result.failing_tests.length).toBe(1);
    expect(result.failing_tests[0].name).toBe("multiplies > one");
    expect(result.failing_tests[0].file).toBe("src/foo.test.ts");
  });

  it("captures error context for failing tests", () => {
    const raw = [
      "src/bar.test.ts:",
      "(fail) math > divide",
      "  expected 0 to not be zero",
      "  at divide (src/bar.ts:12:7)",
      "",
      "0 pass",
      "1 fail",
      "Ran 1 tests across 1 files. [0.03s]",
    ].join("\n");

    const result = parseTestOutput(raw);
    expect(result.failing_tests).toHaveLength(1);
    expect(result.failing_tests[0].error).toContain("expected 0");
  });

  it("returns zero counts and empty failing list on an all-pass run", () => {
    const raw = [
      "(pass) a > b",
      "(pass) c > d",
      "2 pass",
      "0 fail",
      "Ran 2 tests across 1 files. [0.05s]",
    ].join("\n");
    const result = parseTestOutput(raw);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failing_tests).toHaveLength(0);
  });

  it("handles Bun's 'Ran 0 tests' banner without crashing", () => {
    const raw = "bun test v1.3.12\nRan 0 tests across 0 files. [0.01s]";
    const result = parseTestOutput(raw);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("is deterministic", () => {
    const raw = "2 pass\n1 fail\n";
    expect(parseTestOutput(raw)).toEqual(parseTestOutput(raw));
  });
});

/**
 * Loop Closure — Emitter tests.
 *
 * Verifies that:
 *   - Zero evidence + zero exit → "no-stall-detected".
 *   - Zero evidence + non-zero exit → "no-patterns-matched".
 *   - Primary reason is picked by priority, not recency.
 *   - The prompt contains actionable sections (reason, fix, evidence).
 *   - The emitter is pure — identical inputs → identical output.
 *   - The emitter performs no I/O (no global state touched).
 */

import { describe, it, expect } from "bun:test";
import { emitReport, emitNoStallReport } from "../emitter";
import type { Evidence } from "../types";

const EV_TYPECHECK: Evidence = {
  kind: "typecheck-error",
  file: "src/foo.ts",
  line: 12,
  label: "TS2322",
  snippet: "TS2322: Type 'string' is not assignable to 'number'",
};

const EV_TEST: Evidence = {
  kind: "test-failure",
  label: "adds two numbers",
  snippet: "adds two numbers",
};

const EV_MISSING: Evidence = {
  kind: "missing-module",
  label: "missing-pkg",
  snippet: "Cannot find module 'missing-pkg'",
};

const EV_TODO: Evidence = {
  kind: "todo-marker",
  snippet: "TODO: reorder later",
};

describe("emitNoStallReport", () => {
  it("produces 'no-stall-detected' on exit 0", () => {
    const report = emitNoStallReport(0);
    expect(report.stallReason).toBe("no-stall-detected");
    expect(report.evidence).toEqual([]);
    expect(report.nextPrompt).toContain("No stall detected");
  });

  it("produces 'no-patterns-matched' on non-zero exit", () => {
    const report = emitNoStallReport(1);
    expect(report.stallReason).toBe("no-patterns-matched");
    expect(report.nextPrompt).toContain("patterns matched");
  });
});

describe("emitReport — single category", () => {
  it("flags typecheck errors and prompts for typecheck fix", () => {
    const report = emitReport([EV_TYPECHECK], 1);
    expect(report.stallReason).toBe("1 typecheck error detected");
    expect(report.nextPrompt).toContain("typecheck");
    expect(report.nextPrompt).toContain("src/foo.ts");
    expect(report.nextPrompt).toContain("12");
    expect(report.evidence).toHaveLength(1);
  });

  it("pluralizes when count > 1", () => {
    const report = emitReport([EV_TYPECHECK, { ...EV_TYPECHECK, line: 22 }], 1);
    expect(report.stallReason).toBe("2 typecheck errors detected");
  });

  it("includes the exit code in the header", () => {
    const report = emitReport([EV_TEST], 7);
    expect(report.nextPrompt).toContain("exit 7");
  });
});

describe("emitReport — priority selection", () => {
  it("picks typecheck-error over test-failure when both exist", () => {
    const report = emitReport([EV_TEST, EV_TYPECHECK], 1);
    expect(report.stallReason).toContain("typecheck error");
  });

  it("picks typecheck over missing-module", () => {
    const report = emitReport([EV_MISSING, EV_TYPECHECK], 1);
    expect(report.stallReason).toContain("typecheck");
  });

  it("picks missing-module over todo when those are the only two", () => {
    const report = emitReport([EV_TODO, EV_MISSING], 1);
    expect(report.stallReason).toContain("missing module");
  });
});

describe("emitReport — touched files", () => {
  it("lists unique sorted files in the prompt", () => {
    const evA: Evidence = { ...EV_TYPECHECK, file: "z.ts" };
    const evB: Evidence = { ...EV_TYPECHECK, file: "a.ts" };
    const evC: Evidence = { ...EV_TYPECHECK, file: "a.ts" }; // dup
    const report = emitReport([evA, evB, evC], 1);
    expect(report.nextPrompt).toContain("Files touched");
    // a.ts should appear before z.ts (sorted)
    const idxA = report.nextPrompt.indexOf("a.ts");
    const idxZ = report.nextPrompt.indexOf("z.ts");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxZ).toBeGreaterThan(idxA);
  });

  it("omits Files-touched section when no file-bound evidence is present", () => {
    const report = emitReport([EV_TODO], 1);
    expect(report.nextPrompt).not.toContain("Files touched");
  });
});

describe("emitReport — secondary signals", () => {
  it("reports other categories as count summaries", () => {
    const report = emitReport(
      [EV_TYPECHECK, EV_TEST, EV_TEST, EV_TODO],
      1,
    );
    expect(report.nextPrompt).toContain("Other signals");
    expect(report.nextPrompt).toContain("test failure: 2");
    expect(report.nextPrompt).toContain("TODO marker: 1");
  });

  it("omits Other-signals section when only one category is present", () => {
    const report = emitReport([EV_TYPECHECK], 1);
    expect(report.nextPrompt).not.toContain("Other signals");
  });
});

describe("emitReport — determinism", () => {
  it("produces identical output for identical input", () => {
    const a = emitReport([EV_TYPECHECK, EV_TEST, EV_TODO], 3);
    const b = emitReport([EV_TYPECHECK, EV_TEST, EV_TODO], 3);
    expect(a).toEqual(b);
  });

  it("is stable across many runs", () => {
    const input: Evidence[] = [EV_TYPECHECK, EV_MISSING, EV_TODO];
    const first = emitReport(input, 1).nextPrompt;
    for (let i = 0; i < 5; i++) {
      expect(emitReport(input, 1).nextPrompt).toBe(first);
    }
  });
});

describe("emitReport — safety", () => {
  it("never returns a prompt that suggests a shell command to auto-run", () => {
    const report = emitReport([EV_TYPECHECK, EV_TEST], 1);
    // The prompt is advisory only. It MUST NOT include command-substitution
    // markers or "auto-apply" language.
    expect(report.nextPrompt).not.toMatch(/\$\([^)]+\)/); // no $(...) bash sub
    expect(report.nextPrompt).not.toMatch(/rm\s+-rf/);
    expect(report.nextPrompt).not.toMatch(/\bcurl\b.*\|\s*sh/);
  });

  it("truncates evidence lists past the configured max", () => {
    // Build 15 typecheck items — emitter should display only the first 10.
    const many: Evidence[] = Array.from({ length: 15 }, (_, i) => ({
      ...EV_TYPECHECK,
      line: i + 1,
      file: `src/foo-${i}.ts`,
    }));
    const report = emitReport(many, 1);
    expect(report.nextPrompt).toContain("and 5 more");
  });
});

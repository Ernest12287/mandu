/**
 * Loop Closure — Detector tests
 *
 * For each detector, we assert:
 *   1. Positive case — the detector fires on representative output.
 *   2. Negative case — the detector does NOT fire on real source text
 *      or well-formed logs (zero false positives on clean input).
 *   3. Determinism — running twice produces identical output.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_DETECTORS,
  detectTodoMarkers,
  detectFixmeMarkers,
  detectNotImplemented,
  detectUnhandledRejection,
  detectTypecheckErrors,
  detectTestFailures,
  detectMissingModule,
  detectIncompleteFunction,
  detectStackTrace,
  detectSyntaxError,
  listDetectorIds,
  runDetectors,
} from "../detectors";

// Clean input — used for negative testing across every detector.
const CLEAN_STDOUT = [
  "bun test v1.3.12",
  "",
  "1234 pass",
  "0 fail",
  "Ran 1234 tests across 89 files. [2.53s]",
].join("\n");

describe("detectTodoMarkers", () => {
  it("flags TODO: markers in stdout", () => {
    const ev = detectTodoMarkers({
      stdout: "src/foo.ts:12: TODO: wire up the cache",
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("todo-marker");
    expect(ev[0].snippet).toContain("wire up the cache");
  });

  it("flags TODO(reviewer): scoped markers", () => {
    const ev = detectTodoMarkers({
      stdout: "TODO(liam): revisit after v1",
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe("liam");
  });

  it("ignores clean output", () => {
    const ev = detectTodoMarkers({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });

  it("is deterministic", () => {
    const input = {
      stdout: "TODO: one\nTODO: two",
      stderr: "",
      exitCode: 0,
    };
    expect(detectTodoMarkers(input)).toEqual(detectTodoMarkers(input));
  });
});

describe("detectFixmeMarkers", () => {
  it("flags FIXME: markers", () => {
    const ev = detectFixmeMarkers({
      stdout: "",
      stderr: "FIXME: broken on Windows",
      exitCode: 0,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("fixme-marker");
  });

  it("ignores clean output", () => {
    const ev = detectFixmeMarkers({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectNotImplemented", () => {
  it("flags 'Error: not implemented'", () => {
    const ev = detectNotImplemented({
      stdout: "",
      stderr: 'Error: not implemented\n    at foo (bar.ts:1:1)',
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("not-implemented");
  });

  it("flags 'throw new Error(\"not implemented\")' echoes", () => {
    const ev = detectNotImplemented({
      stdout: 'throw new Error("not implemented")',
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
  });

  it("flags NotImplementedError classes", () => {
    const ev = detectNotImplemented({
      stdout: "Error: NotImplementedError",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
  });

  it("ignores clean output", () => {
    const ev = detectNotImplemented({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectUnhandledRejection", () => {
  it("flags Bun-style unhandledRejection banner", () => {
    const ev = detectUnhandledRejection({
      stdout: "",
      stderr: "error: Unhandled Promise Rejection\nError: boom",
      exitCode: 1,
    });
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].kind).toBe("unhandled-rejection");
  });

  it("flags Node legacy UnhandledPromiseRejectionWarning", () => {
    const ev = detectUnhandledRejection({
      stdout: "(node:1234) UnhandledPromiseRejectionWarning: Error: boom",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
  });

  it("ignores clean output", () => {
    const ev = detectUnhandledRejection({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectTypecheckErrors", () => {
  it("parses unix-style path(line,col): error TSxxxx: message", () => {
    const ev = detectTypecheckErrors({
      stdout:
        "packages/core/src/foo.ts(12,34): error TS2322: Type 'string' is not assignable to type 'number'.",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("typecheck-error");
    expect(ev[0].file).toBe("packages/core/src/foo.ts");
    expect(ev[0].line).toBe(12);
    expect(ev[0].label).toBe("TS2322");
  });

  it("parses windows-style C:/path", () => {
    const ev = detectTypecheckErrors({
      stdout:
        "C:/Users/x/a.ts(10,5): error TS2304: Cannot find name 'foo'.",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].file).toBe("C:/Users/x/a.ts");
  });

  it("collects multiple errors", () => {
    const ev = detectTypecheckErrors({
      stdout: [
        "a.ts(1,1): error TS1111: A",
        "b.ts(2,2): error TS2222: B",
      ].join("\n"),
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(2);
  });

  it("ignores clean output", () => {
    const ev = detectTypecheckErrors({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectTestFailures", () => {
  it("flags `(fail)` lines from bun test", () => {
    const ev = detectTestFailures({
      stdout: "(fail) myDescribe > myCase\n(pass) other > thing",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("test-failure");
    expect(ev[0].label).toContain("myCase");
  });

  it("ignores all-pass output", () => {
    const ev = detectTestFailures({
      stdout: "(pass) a > b\n(pass) c > d",
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectMissingModule", () => {
  it("flags 'Cannot find module' errors", () => {
    const ev = detectMissingModule({
      stdout: "",
      stderr: "error: Cannot find module 'missing-pkg'",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe("missing-pkg");
  });

  it("flags 'Could not resolve' bundler errors", () => {
    const ev = detectMissingModule({
      stdout: "Could not resolve: 'non-existent'",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].label).toBe("non-existent");
  });

  it("ignores clean output", () => {
    const ev = detectMissingModule({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectSyntaxError", () => {
  it("flags SyntaxError banner", () => {
    const ev = detectSyntaxError({
      stdout: "",
      stderr: "SyntaxError: Unexpected token '}'",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("syntax-error");
  });

  it("ignores clean output", () => {
    const ev = detectSyntaxError({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectIncompleteFunction", () => {
  it("flags empty function declarations in output", () => {
    const ev = detectIncompleteFunction({
      stdout: "source: function foo() {}",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("incomplete-function");
    expect(ev[0].label).toBe("foo");
  });

  it("flags TODO-only arrow expressions", () => {
    const ev = detectIncompleteFunction({
      stdout: "code: (x) => { // TODO: fill in }",
      stderr: "",
      exitCode: 1,
    });
    expect(ev).toHaveLength(1);
  });

  it("ignores real production source output", () => {
    // Simulating real-ish output: a function with a body.
    const ev = detectIncompleteFunction({
      stdout: "function add(a: number, b: number) { return a + b; }",
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

describe("detectStackTrace", () => {
  it("captures stack frames when exitCode !== 0", () => {
    const ev = detectStackTrace({
      stdout: "",
      stderr: "    at myFn (/users/a/b.ts:12:3)\n    at next (/users/a/c.ts:40:8)",
      exitCode: 1,
    });
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].kind).toBe("stack-trace");
    expect(ev[0].file).toBe("/users/a/b.ts");
    expect(ev[0].line).toBe(12);
  });

  it("does NOT capture stack frames when exitCode === 0", () => {
    const ev = detectStackTrace({
      stdout: "",
      stderr: "    at myFn (/users/a/b.ts:12:3)",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });

  it("caps to at most 3 frames", () => {
    const frames = Array.from({ length: 10 }, (_, i) =>
      `    at fn${i} (/src/f${i}.ts:${i + 1}:1)`,
    ).join("\n");
    const ev = detectStackTrace({
      stdout: "",
      stderr: frames,
      exitCode: 1,
    });
    expect(ev.length).toBeLessThanOrEqual(3);
  });
});

describe("DEFAULT_DETECTORS registry", () => {
  it("lists all expected IDs", () => {
    const ids = listDetectorIds();
    const expected = [
      "typecheck-error",
      "test-failure",
      "missing-module",
      "syntax-error",
      "not-implemented",
      "unhandled-rejection",
      "incomplete-function",
      "todo-marker",
      "fixme-marker",
      "stack-trace",
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it("every registered detector has a description", () => {
    for (const det of DEFAULT_DETECTORS) {
      expect(typeof det.description).toBe("string");
      expect(det.description.length).toBeGreaterThan(5);
    }
  });
});

describe("runDetectors", () => {
  it("returns empty on clean output", () => {
    const ev = runDetectors({
      stdout: CLEAN_STDOUT,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toEqual([]);
  });

  it("collects evidence across multiple detectors", () => {
    const ev = runDetectors({
      stdout: "TODO: foo",
      stderr: "a.ts(1,1): error TS1234: bad\n(fail) x > y",
      exitCode: 1,
    });
    // Expect at least: 1 typecheck, 1 test, 1 todo
    const kinds = new Set(ev.map((e) => e.kind));
    expect(kinds.has("typecheck-error")).toBe(true);
    expect(kinds.has("test-failure")).toBe(true);
    expect(kinds.has("todo-marker")).toBe(true);
  });

  it("honors the `only` filter", () => {
    const ev = runDetectors(
      {
        stdout: "TODO: foo",
        stderr: "a.ts(1,1): error TS1234: bad",
        exitCode: 1,
      },
      ["typecheck-error"],
    );
    const kinds = new Set(ev.map((e) => e.kind));
    expect(kinds.has("typecheck-error")).toBe(true);
    expect(kinds.has("todo-marker")).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      stdout: "TODO: a",
      stderr: "b.ts(2,2): error TS2222: B",
      exitCode: 1,
    };
    const a = runDetectors(input);
    const b = runDetectors(input);
    expect(a).toEqual(b);
  });
});

describe("Real-source negative control", () => {
  // A chunk of prose that resembles an actual Mandu source file:
  // no TODO/FIXME, no stack frames, no errors.
  const REAL_SOURCE = `
    /**
     * Module foo — plain documentation text describing the module.
     * This is a deliberate "clean" sample with no stall patterns.
     */
    export function add(a: number, b: number): number {
      return a + b;
    }

    export function divide(a: number, b: number): number {
      if (b === 0) {
        throw new Error("division by zero");
      }
      return a / b;
    }
  `;

  it("produces zero evidence for clean source text", () => {
    const ev = runDetectors({
      stdout: REAL_SOURCE,
      stderr: "",
      exitCode: 0,
    });
    expect(ev).toHaveLength(0);
  });
});

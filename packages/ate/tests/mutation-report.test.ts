/**
 * Phase C.2 — report aggregation tests.
 */
import { describe, test, expect } from "bun:test";
import { computeMutationReport } from "../src/mutation/report";
import type { MutationResult } from "../src/mutation/runner";

function result(overrides: Partial<MutationResult>): MutationResult {
  return {
    id: "x-0",
    operator: "remove_required_field",
    description: "r",
    durationMs: 1,
    mutatedPath: "tmp",
    status: "killed",
    ...overrides,
  };
}

describe("computeMutationReport", () => {
  test("basic killed/survived split with mutationScore", () => {
    const r = computeMutationReport([
      result({ id: "a", status: "killed" }),
      result({ id: "b", status: "killed" }),
      result({ id: "c", status: "survived" }),
    ]);
    expect(r.killed).toBe(2);
    expect(r.survived).toBe(1);
    expect(r.mutationScore).toBeCloseTo(2 / 3, 5);
  });

  test("survivors get severity ranked high → medium → low", () => {
    const r = computeMutationReport([
      result({ id: "a1", status: "survived", operator: "skip_middleware" }),
      result({ id: "b1", status: "survived", operator: "narrow_type" }),
      result({ id: "c1", status: "survived", operator: "rename_field" }),
      result({ id: "d1", status: "survived", operator: "remove_required_field" }),
    ]);
    expect(r.survivorsBySeverity[0].severity).toBe("high");
    const sevs = r.survivorsBySeverity.map((s) => s.severity);
    const idx = (s: string) => sevs.indexOf(s);
    expect(idx("high")).toBeLessThan(idx("medium"));
    expect(idx("medium")).toBeLessThan(idx("low"));
  });

  test("byOperator aggregates totals correctly", () => {
    const r = computeMutationReport([
      result({ id: "a", status: "killed", operator: "narrow_type" }),
      result({ id: "b", status: "survived", operator: "narrow_type" }),
      result({ id: "c", status: "killed", operator: "widen_enum" }),
    ]);
    expect(r.byOperator.narrow_type).toEqual({ total: 2, killed: 1, survived: 1 });
    expect(r.byOperator.widen_enum).toEqual({ total: 1, killed: 1, survived: 0 });
  });

  test("timeouts and errors excluded from mutationScore denominator", () => {
    const r = computeMutationReport([
      result({ id: "a", status: "killed" }),
      result({ id: "b", status: "timeout" }),
      result({ id: "c", status: "error" }),
    ]);
    // denom = killed(1) + survived(0) = 1 ⇒ score = 1.0.
    expect(r.mutationScore).toBeCloseTo(1, 5);
    expect(r.timeout).toBe(1);
    expect(r.error).toBe(1);
  });
});

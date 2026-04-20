/**
 * Phase 18.φ — Bundle size budget regression tests.
 *
 * Covers the 10+ cases called out in the spec:
 *   1. No budget config → evaluator returns null (passthrough).
 *   2. Empty `{}` budget → default 250 KB gzip ceiling applied.
 *   3. Within limits → every island status === "within".
 *   4. Exceeds raw-only ceiling → rawStatus exceeded, composite exceeded.
 *   5. Exceeds gz-only ceiling → gzStatus exceeded.
 *   6. Per-island override tightens one axis without losing the other.
 *   7. Total cap (maxTotalRawBytes / maxTotalGzBytes) reports independently.
 *   8. Mode 'warning' (default) → hasExceeded true but caller decides.
 *   9. Mode 'error' → hasExceeded true, mode propagated for CLI dispatch.
 *  10. APPROACHING (≥90% of limit) yields within10 status.
 *  11. perIsland pinning to 0 rejects any emission for that island.
 *  12. resolveBudget surfaces the default constant.
 *  13. Table/formatting helpers render every row + include status labels.
 */

import { describe, expect, test } from "bun:test";

import type { AnalyzeReport } from "../../src/bundler/analyzer";
import {
  APPROACHING_THRESHOLD_RATIO,
  DEFAULT_BUDGET_MAX_GZ_BYTES,
  evaluateBudget,
  formatBudgetBytes,
  formatBudgetTable,
  resolveBudget,
  type BundleBudget,
} from "../../src/bundler/budget";

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeReport(
  islands: Array<{ name: string; raw: number; gz: number }>,
  sharedRaw = 0,
  sharedGz = 0
): AnalyzeReport {
  const islandRaw = islands.reduce((s, i) => s + i.raw, 0);
  const islandGz = islands.reduce((s, i) => s + i.gz, 0);
  return {
    islands: islands.map((i) => ({
      name: i.name,
      js: `/.mandu/client/${i.name}.js`,
      totalRaw: i.raw,
      totalGz: i.gz,
      priority: "visible" as const,
      shared: [],
      modules: [],
    })),
    shared: [],
    summary: {
      totalRaw: islandRaw + sharedRaw,
      totalGz: islandGz + sharedGz,
      largestIsland: islands[0]
        ? { name: islands[0].name, totalRaw: islands[0].raw }
        : null,
      heaviestDep: null,
      islandCount: islands.length,
      sharedCount: 0,
      dedupeSavings: 0,
      version: 1,
      generatedAt: "2026-04-20T00:00:00.000Z",
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("evaluateBudget — passthrough when no config", () => {
  test("returns null when budget is undefined", () => {
    const report = makeReport([{ name: "home", raw: 100_000, gz: 30_000 }]);
    expect(evaluateBudget(report, undefined)).toBeNull();
  });
});

describe("evaluateBudget — default ceiling applied to empty budget", () => {
  test("empty object triggers DEFAULT_BUDGET_MAX_GZ_BYTES", () => {
    const report = makeReport([{ name: "big", raw: 1_000_000, gz: 300_000 }]);
    const result = evaluateBudget(report, {});
    expect(result).not.toBeNull();
    expect(result!.islands[0].gzLimit).toBe(DEFAULT_BUDGET_MAX_GZ_BYTES);
    expect(result!.islands[0].gzStatus).toBe("exceeded");
    expect(result!.hasExceeded).toBe(true);
    expect(result!.mode).toBe("warning");
  });

  test("empty object with mode preserved applies default", () => {
    const report = makeReport([{ name: "big", raw: 1_000_000, gz: 300_000 }]);
    const result = evaluateBudget(report, { mode: "error" });
    expect(result!.mode).toBe("error");
    expect(result!.islands[0].gzLimit).toBe(DEFAULT_BUDGET_MAX_GZ_BYTES);
  });
});

describe("evaluateBudget — within limits", () => {
  test("every axis under ceiling → status within, hasExceeded false", () => {
    const report = makeReport([
      { name: "home", raw: 50_000, gz: 15_000 },
      { name: "about", raw: 30_000, gz: 8_000 },
    ]);
    const budget: BundleBudget = {
      maxRawBytes: 200_000,
      maxGzBytes: 60_000,
    };
    const result = evaluateBudget(report, budget);
    expect(result!.hasExceeded).toBe(false);
    expect(result!.withinCount).toBe(2);
    expect(result!.exceededCount).toBe(0);
    for (const i of result!.islands) {
      expect(i.status).toBe("within");
    }
  });
});

describe("evaluateBudget — exceed raw ceiling", () => {
  test("raw over, gz under → rawStatus exceeded, composite exceeded", () => {
    const report = makeReport([{ name: "home", raw: 500_000, gz: 10_000 }]);
    const result = evaluateBudget(report, { maxRawBytes: 100_000 });
    expect(result!.islands[0].rawStatus).toBe("exceeded");
    expect(result!.islands[0].gzStatus).toBe("within");
    expect(result!.islands[0].status).toBe("exceeded");
    expect(result!.hasExceeded).toBe(true);
    expect(result!.exceededCount).toBe(1);
  });
});

describe("evaluateBudget — exceed gz ceiling", () => {
  test("gz over only → gzStatus exceeded, composite exceeded", () => {
    const report = makeReport([{ name: "home", raw: 50_000, gz: 200_000 }]);
    const result = evaluateBudget(report, { maxGzBytes: 100_000 });
    expect(result!.islands[0].rawStatus).toBe("within");
    expect(result!.islands[0].gzStatus).toBe("exceeded");
    expect(result!.islands[0].status).toBe("exceeded");
  });
});

describe("evaluateBudget — per-island override", () => {
  test("override tightens one axis; global applies to the other axis", () => {
    const report = makeReport([
      { name: "home", raw: 600_000, gz: 40_000 },
      { name: "about", raw: 100_000, gz: 10_000 },
    ]);
    const budget: BundleBudget = {
      maxRawBytes: 800_000, // global: generous
      maxGzBytes: 100_000, // global: generous
      perIsland: {
        home: { gz: 30_000 }, // tight gz override on home only
      },
    };
    const result = evaluateBudget(report, budget);
    const home = result!.islands.find((i) => i.name === "home")!;
    const about = result!.islands.find((i) => i.name === "about")!;
    expect(home.gzLimit).toBe(30_000);
    expect(home.rawLimit).toBe(800_000); // still global
    expect(home.gzStatus).toBe("exceeded");
    expect(home.overridden).toBe(true);
    expect(about.gzLimit).toBe(100_000); // untouched by override
    expect(about.overridden).toBe(false);
  });

  test("perIsland pin to 0 rejects any emission", () => {
    const report = makeReport([{ name: "legacy", raw: 10, gz: 5 }]);
    const budget: BundleBudget = {
      perIsland: { legacy: { raw: 0, gz: 0 } },
    };
    const result = evaluateBudget(report, budget);
    expect(result!.islands[0].rawStatus).toBe("exceeded");
    expect(result!.islands[0].gzStatus).toBe("exceeded");
  });
});

describe("evaluateBudget — project total cap", () => {
  test("maxTotalRawBytes populates total + reports exceed", () => {
    const report = makeReport(
      [
        { name: "a", raw: 400_000, gz: 100_000 },
        { name: "b", raw: 400_000, gz: 100_000 },
      ],
      200_000, // shared raw
      50_000 // shared gz
    );
    // total raw = 800_000 + 200_000 = 1_000_000; total gz = 200_000 + 50_000
    const result = evaluateBudget(report, {
      maxTotalRawBytes: 900_000,
      maxTotalGzBytes: 300_000, // generous
    });
    expect(result!.total).not.toBeNull();
    expect(result!.total!.raw).toBe(1_000_000);
    expect(result!.total!.rawStatus).toBe("exceeded");
    expect(result!.total!.gzStatus).toBe("within");
    expect(result!.total!.status).toBe("exceeded");
    expect(result!.hasExceeded).toBe(true);
  });

  test("no total cap → total is null", () => {
    const report = makeReport([{ name: "a", raw: 100, gz: 50 }]);
    const result = evaluateBudget(report, { maxRawBytes: 500 });
    expect(result!.total).toBeNull();
  });
});

describe("evaluateBudget — mode propagation", () => {
  test("mode defaults to 'warning' when omitted", () => {
    const report = makeReport([{ name: "home", raw: 10, gz: 5 }]);
    const result = evaluateBudget(report, { maxRawBytes: 1 });
    expect(result!.mode).toBe("warning");
    expect(result!.hasExceeded).toBe(true);
  });

  test("mode 'error' is surfaced to caller unchanged", () => {
    const report = makeReport([{ name: "home", raw: 10, gz: 5 }]);
    const result = evaluateBudget(report, { maxRawBytes: 1, mode: "error" });
    expect(result!.mode).toBe("error");
  });
});

describe("evaluateBudget — within10 (APPROACHING) band", () => {
  test("gz ≥ 90% of limit but < 100% → gzStatus within10", () => {
    const limit = 100_000;
    // 90_000 is exactly at the threshold; 91_000 above it.
    const report = makeReport([
      { name: "near", raw: 10, gz: Math.ceil(limit * APPROACHING_THRESHOLD_RATIO) + 5 },
    ]);
    const result = evaluateBudget(report, { maxGzBytes: limit });
    expect(result!.islands[0].gzStatus).toBe("within10");
    expect(result!.islands[0].status).toBe("within10");
    expect(result!.approachingCount).toBe(1);
    expect(result!.hasExceeded).toBe(false);
  });
});

describe("resolveBudget", () => {
  test("undefined input → null", () => {
    expect(resolveBudget(undefined)).toBeNull();
  });

  test("explicit ceiling disables the default", () => {
    const r = resolveBudget({ maxRawBytes: 999 });
    expect(r!.maxGzBytes).toBeUndefined();
    expect(r!.maxRawBytes).toBe(999);
  });

  test("empty object gets default gz ceiling", () => {
    const r = resolveBudget({});
    expect(r!.maxGzBytes).toBe(DEFAULT_BUDGET_MAX_GZ_BYTES);
    expect(r!.mode).toBe("warning");
  });
});

describe("formatBudgetBytes", () => {
  test("renders B / KB / MB brackets", () => {
    expect(formatBudgetBytes(0)).toBe("0 B");
    expect(formatBudgetBytes(42)).toBe("42 B");
    expect(formatBudgetBytes(2048)).toBe("2.0 KB");
    expect(formatBudgetBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});

describe("formatBudgetTable", () => {
  test("renders every island + total rows with status labels", () => {
    const report = makeReport(
      [
        { name: "home", raw: 200_000, gz: 60_000 },
        { name: "about", raw: 20_000, gz: 4_000 },
      ],
      0,
      0
    );
    const budget: BundleBudget = {
      maxGzBytes: 50_000,
      maxTotalGzBytes: 100_000,
    };
    const br = evaluateBudget(report, budget)!;
    const table = formatBudgetTable(br);
    expect(table).toContain("home");
    expect(table).toContain("about");
    expect(table).toContain("<total>");
    expect(table).toContain("EXCEEDED"); // home gz over 50k
    expect(table).toContain("OK"); // about within
  });
});

/**
 * auto-heal — deterministic selector-drift healer tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoHeal, applyHeal, computeSimilarity } from "../src/auto-heal";
import type { FailureV1 } from "../schemas/failure.v1";

function makeFailure(candidates: Array<{ selector: string; similarity: number; reason?: string }>): FailureV1 {
  return {
    status: "fail",
    kind: "selector_drift",
    detail: {
      old: "[data-testid=submit]",
      domCandidates: candidates,
    },
    healing: { auto: [], requires_llm: false },
    flakeScore: 0,
    lastPassedAt: null,
    graphVersion: "gv1:test",
    trace: {},
  };
}

describe("auto-heal (Phase A.2)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "ate-autoheal-"));
    delete process.env.MANDU_ATE_AUTO_HEAL_THRESHOLD;
  });

  afterEach(() => {
    try {
      rmSync(repoRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    delete process.env.MANDU_ATE_AUTO_HEAL_THRESHOLD;
  });

  test("high-confidence candidate above threshold is returned", () => {
    const failure = makeFailure([
      { selector: "button.btn-primary", similarity: 0.92, reason: "text match + role=button" },
      { selector: "button[type=submit]", similarity: 0.55, reason: "role match only" },
    ]);
    const actions = autoHeal(failure, { repoRoot });
    expect(actions.length).toBe(1);
    expect(actions[0].change).toBe("selector_replace");
    expect(actions[0].old).toBe("[data-testid=submit]");
    expect(actions[0].new).toBe("button.btn-primary");
    expect(actions[0].confidence).toBeCloseTo(0.92);
  });

  test("borderline candidate exactly at threshold passes; below is dropped", () => {
    const failure = makeFailure([
      { selector: "button.exact-0_75", similarity: 0.75 }, // exactly threshold
      { selector: "button.almost", similarity: 0.74 }, // just below
    ]);
    const actions = autoHeal(failure, { repoRoot });
    expect(actions.map((a) => a.new)).toEqual(["button.exact-0_75"]);
  });

  test("low-confidence candidates are rejected (empty output)", () => {
    const failure = makeFailure([
      { selector: "button.low-1", similarity: 0.3 },
      { selector: "button.low-2", similarity: 0.4 },
    ]);
    expect(autoHeal(failure, { repoRoot })).toEqual([]);
  });

  test("MANDU_ATE_AUTO_HEAL_THRESHOLD env overrides default", () => {
    process.env.MANDU_ATE_AUTO_HEAL_THRESHOLD = "0.5";
    const failure = makeFailure([
      { selector: "button.mid", similarity: 0.55 },
      { selector: "button.low", similarity: 0.45 },
    ]);
    const actions = autoHeal(failure, { repoRoot });
    expect(actions).toHaveLength(1);
    expect(actions[0].new).toBe("button.mid");

    // Explicit threshold argument wins over env.
    const actions2 = autoHeal(failure, { repoRoot, threshold: 0.9 });
    expect(actions2).toHaveLength(0);
  });

  test("dry-run: autoHeal never writes; applyHeal writes exactly once per match", () => {
    // Seed a spec file and a failure.
    mkdirSync(join(repoRoot, "tests", "e2e"), { recursive: true });
    const specPath = join(repoRoot, "tests", "e2e", "signup.spec.ts");
    const original = `await page.locator('[data-testid=submit]').click();\nawait expect(page.locator('[data-testid=submit]')).toBeVisible();`;
    writeFileSync(specPath, original, "utf8");

    const failure = makeFailure([
      { selector: "button.btn-primary", similarity: 0.85 },
    ]);
    const actions = autoHeal(failure, { repoRoot });
    expect(actions).toHaveLength(1);

    // autoHeal must not touch disk.
    const afterDry = readFileSync(specPath, "utf8");
    expect(afterDry).toBe(original);

    // applyHeal actually writes.
    const result = applyHeal({
      repoRoot,
      spec: "tests/e2e/signup.spec.ts",
      change: actions[0],
    });
    expect(result.applied).toBe(true);
    expect(result.changedLines).toBe(2);
    const afterApply = readFileSync(specPath, "utf8");
    expect(afterApply).not.toContain("[data-testid=submit]");
    expect(afterApply).toContain("button.btn-primary");

    // computeSimilarity sanity-check — identical DOM paths = score > 0.2 weight only.
    const sim = computeSimilarity({
      old: "[data-testid=submit]",
      candidate: "button.btn-primary",
      target: { text: "Submit", role: "button" },
      candidateAttrs: { text: "Submit", role: "button" },
    });
    expect(sim).toBeGreaterThan(0.75);

    // applyHeal on a non-existent file surfaces a clean error.
    const missing = applyHeal({
      repoRoot,
      spec: "tests/e2e/does-not-exist.spec.ts",
      change: actions[0],
    });
    expect(missing.applied).toBe(false);
    expect(missing.error).toMatch(/not found/);
    expect(existsSync(specPath)).toBe(true);
  });
});

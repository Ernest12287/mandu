/**
 * Phase 7.0 — 36-scenario HMR test matrix (3 project forms × 12 change kinds)
 *
 * This module is the SINGLE SOURCE OF TRUTH for the matrix that:
 *   - Agent E (R2) builds the Playwright test harness around
 *   - Agent F (R3) asserts latency targets against
 *   - Any future regression test iterates over
 *
 * The matrix intentionally enumerates every combination even when a cell
 * is trivially n/a (e.g. `island.client.tsx` in a pure-SSG project with
 * zero islands) — `expectedBehavior: "n/a"` keeps the matrix square so
 * the iteration loop doesn't need per-cell conditionals.
 *
 * References:
 *   docs/bun/phase-7-team-plan.md §3.3
 *   docs/bun/phase-7-diagnostics/performance-reliability.md §4 (매트릭스 초안)
 */

// ============================================
// Dimensions
// ============================================

/**
 * Three representative project shapes. Each R2 E fixture corresponds to
 * one of these.
 */
export const PROJECT_FORMS = [
  "pure-ssg",         // no hydration, SSR → HTML only
  "hybrid",           // some pages with islands, some SSR-only
  "full-interactive", // every route has at least one island
] as const;

export type ProjectForm = (typeof PROJECT_FORMS)[number];

/**
 * File change kinds the matrix covers. Order matters only for stable
 * report output — the iterating test runner relies on `for (const k of
 * CHANGE_KINDS)`.
 *
 * Kept in sync with `docs/bun/phase-7-diagnostics/performance-reliability.md §4`.
 */
export const CHANGE_KINDS = [
  "app/page.tsx",
  "app/slot.ts",
  "app/layout.tsx",
  "app/contract.ts",          // Agent D new coverage
  "spec/resource.ts",         // Agent D new coverage
  "app/middleware.ts",        // Agent D new coverage
  "island.client.tsx",
  "src/shared/**",
  "src/top-level.ts",         // Agent A new coverage (B1 fix)
  "css",
  "mandu.config.ts",          // Agent D new coverage
  ".env",                     // Agent D new coverage
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

// ============================================
// Cell shape
// ============================================

/**
 * Every matrix cell's expected outcome. The test harness picks the
 * right assertion strategy based on this field.
 *
 * - `"island-update"`   : expect `island-update` WS message; DOM patch
 *                         without full navigation; form/scroll preserved.
 * - `"full-reload"`     : expect `full-reload` or `reload` WS message;
 *                         fresh HTML; previous state cleared.
 * - `"prerender-regen"` : Pure-SSR common-dir path; expect #188 fix —
 *                         new HTML reachable after reload.
 * - `"css-update"`      : expect `css-update`; <link> re-timestamped; no
 *                         full reload.
 * - `"server-restart"`  : expect `mandu.config.ts` / `.env` auto-restart;
 *                         dev server responds on same port after delay.
 * - `"code-regen"`      : expect contract/resource artifact regenerated
 *                         AND handler re-registered (no browser event
 *                         needed unless UI-visible).
 * - `"n/a"`             : combination impossible in that project form
 *                         (e.g. island change in pure-ssg).
 */
export type ExpectedBehavior =
  | "island-update"
  | "full-reload"
  | "prerender-regen"
  | "css-update"
  | "server-restart"
  | "code-regen"
  | "n/a";

/**
 * A single matrix cell. Agent E materializes one Playwright test per
 * cell; Agent F measures `REBUILD_TOTAL` on the same cells and asserts
 * latency against the target.
 */
export interface ScenarioCell {
  projectForm: ProjectForm;
  changeKind: ChangeKind;
  expectedBehavior: ExpectedBehavior;
  /**
   * Target `REBUILD_TOTAL` P95 in ms. `null` for `n/a` cells or
   * `server-restart` (restart time varies by project startup).
   */
  latencyTargetMs: number | null;
}

// ============================================
// The 36 cells
// ============================================

/** Total cell count — mirrored in tests so they fail loudly if the
 *  matrix shape changes.
 *
 *  NOTE: Declared BEFORE `SCENARIO_CELLS` so `buildMatrix()` — which runs
 *  during the `SCENARIO_CELLS` initializer and references this constant
 *  for its sanity check — does not hit a TDZ ReferenceError. The pair is
 *  still conceptually "matrix shape" metadata; they're co-located. */
export const EXPECTED_CELL_COUNT = PROJECT_FORMS.length * CHANGE_KINDS.length;

/**
 * Pre-computed matrix. Derived once at module load so importers don't
 * pay the lookup cost per test.
 */
export const SCENARIO_CELLS: readonly ScenarioCell[] = buildMatrix();

/** Look up a single cell. O(n) — matrix is small. */
export function findCell(
  projectForm: ProjectForm,
  changeKind: ChangeKind,
): ScenarioCell {
  const cell = SCENARIO_CELLS.find(
    (c) => c.projectForm === projectForm && c.changeKind === changeKind,
  );
  if (!cell) {
    throw new Error(
      `No scenario cell for ${projectForm} × ${changeKind}. Add it to scenario-matrix.ts.`,
    );
  }
  return cell;
}

// ============================================
// Matrix construction
// ============================================

function buildMatrix(): ScenarioCell[] {
  const cells: ScenarioCell[] = [];
  for (const projectForm of PROJECT_FORMS) {
    for (const changeKind of CHANGE_KINDS) {
      cells.push({
        projectForm,
        changeKind,
        expectedBehavior: classifyBehavior(projectForm, changeKind),
        latencyTargetMs: classifyTarget(projectForm, changeKind),
      });
    }
  }
  if (cells.length !== EXPECTED_CELL_COUNT) {
    throw new Error(
      `scenario-matrix.ts built ${cells.length} cells, expected ${EXPECTED_CELL_COUNT}.`,
    );
  }
  return cells;
}

function classifyBehavior(
  projectForm: ProjectForm,
  changeKind: ChangeKind,
): ExpectedBehavior {
  // Island changes only apply to forms with islands.
  if (changeKind === "island.client.tsx") {
    return projectForm === "pure-ssg" ? "n/a" : "island-update";
  }

  // CSS is always style-swap.
  if (changeKind === "css") return "css-update";

  // Config / env always restart.
  if (changeKind === "mandu.config.ts" || changeKind === ".env") {
    return "server-restart";
  }

  // Contract / resource trigger code-gen + handler re-register.
  if (changeKind === "app/contract.ts" || changeKind === "spec/resource.ts") {
    return "code-regen";
  }

  // src/shared + src/top-level in pure-SSG needs the #188 prerender path.
  if (
    projectForm === "pure-ssg" &&
    (changeKind === "src/shared/**" || changeKind === "src/top-level.ts")
  ) {
    return "prerender-regen";
  }

  // Everything else is a full reload (SSR-rendered page, layout, slot,
  // middleware, common deps in hybrid/interactive projects). Full reload
  // is the honest fallback — SSR has no React state to preserve.
  return "full-reload";
}

function classifyTarget(
  projectForm: ProjectForm,
  changeKind: ChangeKind,
): number | null {
  const behavior = classifyBehavior(projectForm, changeKind);
  switch (behavior) {
    case "n/a":
      return null;
    case "island-update":
      return 50; // HMR_PERF_TARGETS.ISLAND_REBUILD_P95_MS
    case "css-update":
      return 100; // HMR_PERF_TARGETS.CSS_REBUILD_P95_MS
    case "server-restart":
      return null; // project-dependent, not an HMR target
    case "code-regen":
      return 400; // regen is heavier than a plain rebuild
    case "prerender-regen":
      return 400; // fan-out across all prerendered routes
    case "full-reload":
      // src/shared in hybrid/interactive → common-dir rebuild (400ms),
      // otherwise a single SSR page (200ms).
      if (changeKind === "src/shared/**" || changeKind === "src/top-level.ts") {
        return 400; // HMR_PERF_TARGETS.COMMON_DIR_REBUILD_P95_MS
      }
      return 200; // HMR_PERF_TARGETS.SSR_REBUILD_P95_MS
  }
}

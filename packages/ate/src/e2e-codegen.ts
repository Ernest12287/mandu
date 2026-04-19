/**
 * ATE E2E codegen — Phase 12.2
 *
 * Thin pipeline that turns the extracted interaction graph into
 * Playwright `.spec.ts` files via the shared prompt library.
 *
 * The existing deterministic codegen (`generatePlaywrightSpecs` in
 * `./codegen.ts`) emits tests from scenarios + selector map without an
 * LLM — that path stays primary for correctness. This module augments
 * it with a `buildE2EPlan()` helper that a CLI `--dry-run` can use to
 * preview what would be generated AND with `generateE2EPrompts()` which
 * returns the `PromptSpec[]` the caller would feed to an LLM when the
 * `--e2e` flag is combined with a provider adapter (Agent F owns the
 * adapter side; see `packages/ate/src/prompts/adapters/*`).
 *
 * Plan output is deterministic: given the same interaction graph, the
 * same list of prompts, file targets, and oracle level is returned.
 * This makes the `--dry-run` path reproducible in tests.
 */

import { join } from "node:path";
import { getAtePaths, readJson } from "./fs";
import type { InteractionGraph, InteractionNode, OracleLevel } from "./types";
import { promptFor } from "./prompts";
import type { PromptProvider, PromptSpec } from "./prompts";

type RouteNode = Extract<InteractionNode, { kind: "route" }>;

/** Options accepted by every codegen helper in this module. */
export interface E2ECodegenOptions {
  /** Project root (where `.mandu/interaction-graph.json` lives). */
  repoRoot: string;
  /**
   * Only operate on routes with these IDs. Useful for `--filter` and
   * impact-based subset runs. Empty / undefined → all routes.
   */
  onlyRoutes?: string[];
  /** Oracle level used in the prompt / log output. Default L1. */
  oracleLevel?: OracleLevel;
  /**
   * LLM provider for the prompt adapter. Default: `"claude"`. Callers
   * that only want the deterministic spec output can ignore prompts.
   */
  provider?: PromptProvider;
}

/** A single item in the plan — one route → one spec file. */
export interface E2ECodegenPlanItem {
  /** Route identifier (e.g. "/dashboard"). */
  routeId: string;
  /** Absolute output path of the planned spec file. */
  specFile: string;
  /** Source file the spec targets. */
  sourceFile: string;
  /** HTTP methods on the route (informational). */
  methods: string[];
}

/** The full plan returned by `buildE2EPlan`. */
export interface E2ECodegenPlan {
  /** Oracle level pinned by the caller / default. */
  oracleLevel: OracleLevel;
  /** Routes that will be processed. */
  items: E2ECodegenPlanItem[];
  /** Routes filtered out because `onlyRoutes` excluded them. */
  skipped: string[];
  /** Non-fatal notes (e.g. "Interaction graph missing; run extract"). */
  warnings: string[];
  /** Destination directory under the repo root. */
  outDir: string;
}

const DEFAULT_OUT_DIR = "tests/e2e/auto";

/**
 * Slugify a route path / id for use as a filename. Mirrors the behavior
 * of `codegen.ts` so `--dry-run` and the real codegen produce the same
 * target file names.
 */
function safeFilename(routeId: string): string {
  return routeId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Read the interaction graph and enumerate what would be generated.
 *
 * This is pure bookkeeping — it does NOT spawn the LLM, does NOT write
 * any files, and does NOT require `@playwright/test` at runtime. It is
 * therefore safe to call from `--dry-run` in any environment.
 */
export function buildE2EPlan(opts: E2ECodegenOptions): E2ECodegenPlan {
  const paths = getAtePaths(opts.repoRoot);
  const oracleLevel: OracleLevel = opts.oracleLevel ?? "L1";
  const outDir = join(opts.repoRoot, DEFAULT_OUT_DIR);

  const warnings: string[] = [];
  let graph: InteractionGraph;
  try {
    graph = readJson<InteractionGraph>(paths.interactionGraphPath);
  } catch (err: unknown) {
    warnings.push(
      `Interaction graph not loaded (${err instanceof Error ? err.message : String(err)}). ` +
        "Run 'mandu test:auto' or 'mandu ate extract' before --e2e.",
    );
    return {
      oracleLevel,
      items: [],
      skipped: [],
      warnings,
      outDir,
    };
  }

  const allRoutes = (graph.nodes ?? []).filter(
    (n): n is RouteNode => n.kind === "route",
  );

  const onlyRoutes = opts.onlyRoutes?.filter((s) => s.length > 0);
  const filterSet = onlyRoutes?.length ? new Set(onlyRoutes) : null;

  const items: E2ECodegenPlanItem[] = [];
  const skipped: string[] = [];

  for (const route of allRoutes) {
    if (filterSet && !filterSet.has(route.id)) {
      skipped.push(route.id);
      continue;
    }
    items.push({
      routeId: route.id,
      specFile: join(outDir, `${safeFilename(route.id)}.spec.ts`),
      sourceFile: route.file,
      methods: route.methods ?? ["GET"],
    });
  }

  if (items.length === 0 && filterSet) {
    warnings.push(
      `No routes matched --filter (${Array.from(filterSet).join(",")}). ` +
        `Graph has ${allRoutes.length} route(s).`,
    );
  } else if (items.length === 0) {
    warnings.push(
      `Interaction graph contains no route nodes — nothing to generate. ` +
        `Create app/page.tsx or app/**/route.ts and re-extract.`,
    );
  }

  return {
    oracleLevel,
    items,
    skipped,
    warnings,
    outDir,
  };
}

/**
 * Build per-route prompts using the shared prompt library.
 *
 * Returns `PromptSpec[]` — one per planned route. The CLI layer decides
 * whether to pipe them through a real LLM or to fall back to the
 * deterministic codegen. Prompts are XML-tagged (`e2eTestTemplate`) and
 * carry the route id, path, source file, and optional snippet.
 */
export function generateE2EPrompts(
  plan: E2ECodegenPlan,
  opts: { provider?: PromptProvider; repoRoot: string } = { repoRoot: "" },
): PromptSpec[] {
  const provider: PromptProvider = opts.provider ?? "claude";
  const out: PromptSpec[] = [];

  for (const item of plan.items) {
    out.push(
      promptFor({
        kind: "e2e-test",
        provider,
        context: opts.repoRoot ? { repoRoot: opts.repoRoot } : undefined,
        target: {
          id: item.routeId,
          file: item.sourceFile,
          path: item.routeId,
          methods: item.methods,
        },
      }),
    );
  }

  return out;
}

/**
 * Format the plan as a human-readable summary. Used by `--dry-run` in
 * the CLI so the operator can eyeball the generation scope before
 * committing to a full run.
 */
export function describeE2EPlan(plan: E2ECodegenPlan): string {
  const lines: string[] = [];
  lines.push(`ATE E2E generation plan (oracle ${plan.oracleLevel})`);
  lines.push(`  out: ${plan.outDir}`);
  lines.push(`  routes: ${plan.items.length}`);
  if (plan.items.length > 0) {
    for (const item of plan.items.slice(0, 20)) {
      lines.push(`    - ${item.routeId}  [${item.methods.join(",")}]  → ${item.specFile}`);
    }
    if (plan.items.length > 20) {
      lines.push(`    (+${plan.items.length - 20} more)`);
    }
  }
  if (plan.skipped.length > 0) {
    lines.push(`  skipped: ${plan.skipped.length}`);
  }
  if (plan.warnings.length > 0) {
    lines.push(`  warnings:`);
    for (const w of plan.warnings) lines.push(`    - ${w}`);
  }
  return lines.join("\n");
}

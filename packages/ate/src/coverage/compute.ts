/**
 * Phase B.4 — Coverage metrics.
 *
 * Pure function. Inputs:
 *   - InteractionGraph (route / filling / island / slot / form nodes)
 *   - SpecIndex       (which spec covers which routeId)
 *   - boundary probe generator (B.1)
 *   - repo root (for reading spec source — boundary coverage needs
 *     substring matching on spec text for probe values / categories)
 *
 * Output: per docs/ate/phase-b-spec.md §B.5 shape.
 *
 * "withBoundaryCoverage" computation:
 *   For each contract C:
 *     probes = generateProbes({ contractName: basename(C) })
 *     if every probe is found in at least one spec covering any route
 *     linked to C → withBoundaryCoverage += 1
 *     else if some probe is found → withPartialBoundary += 1
 *     else → withNoBoundary += 1
 *
 * Finding a probe in a spec:
 *   - literal probe.value substring present in the spec source, OR
 *   - probe.category string (e.g. "boundary_min") present in the spec
 *     source (describe/it title convention).
 *
 * "invariant" judgment:
 *   - middleware presence on a route → route is a candidate for the
 *     invariant (csrf / rate-limit / session / auth / i18n)
 *   - route has ≥ 1 spec whose filename OR test-name contains the
 *     invariant keyword (case-insensitive) → "covered"
 *   - route has middleware but no matching spec → "missing"
 *   - at least one spec exists but fewer assertions than the contract's
 *     probe count → "partial"
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import fg from "fast-glob";
import type { InteractionGraph, InteractionNode } from "../types";
import { graphVersionFromGraph } from "../graph-version";
import { indexSpecs, type SpecIndex, type IndexedSpec } from "../spec-indexer";
import { routeIdFromPath } from "../extractor-utils";
import { generateProbes } from "../boundary";
import { getAtePaths, fileExists } from "../fs";

export interface CoverageMetrics {
  routes: {
    total: number;
    withUnitSpec: number;
    withIntegrationSpec: number;
    withE2ESpec: number;
    withAnyKindOfSpec: number;
  };
  contracts: {
    total: number;
    withBoundaryCoverage: number;
    withPartialBoundary: number;
    withNoBoundary: number;
  };
  invariants: {
    csrf: "covered" | "partial" | "missing";
    rate_limit: "covered" | "partial" | "missing";
    session: "covered" | "partial" | "missing";
    auth: "covered" | "partial" | "missing";
    i18n: "covered" | "partial" | "missing";
  };
  topGaps: Array<{
    kind: "route_without_spec" | "contract_without_boundary" | "invariant_missing";
    target: string;
    severity: "high" | "medium" | "low";
    reason: string;
  }>;
  graphVersion: string;
}

export interface ComputeCoverageOptions {
  /**
   * Optional scope filter. When "route" or "contract", the returned
   * `routes` / `contracts` counts are filtered to just the target.
   */
  scope?: "project" | "route" | "contract";
  /** Route id or contract name (used when `scope !== "project"`). */
  target?: string;
  /** Pre-loaded inputs — tests inject to avoid FS. */
  graph?: InteractionGraph;
  specIndex?: SpecIndex;
  /** Skip boundary probe generation (tests use this to stub). */
  skipBoundaryProbe?: boolean;
}

export async function computeCoverage(
  repoRoot: string,
  options: ComputeCoverageOptions = {},
): Promise<CoverageMetrics> {
  const graph = options.graph ?? loadGraph(repoRoot);
  const specIndex = options.specIndex ?? indexSpecs(repoRoot);
  const graphVersion = graphVersionFromGraph(graph);

  if (!graph) {
    return emptyMetrics(graphVersion);
  }

  let routeNodes = (graph.nodes ?? []).filter(
    (n): n is Extract<InteractionNode, { kind: "route" }> => n.kind === "route",
  );

  // Route-scope filter: keep only the target route.
  if (options.scope === "route" && options.target) {
    const target = options.target;
    routeNodes = routeNodes.filter((r) => {
      const id = r.routeId ?? routeIdFromPath(r.path);
      return id === target || r.path === target;
    });
  }

  // ── routes by spec coverage ──
  const bySpecKind = {
    unit: 0,
    integration: 0,
    e2e: 0,
    any: 0,
  };

  for (const r of routeNodes) {
    const id = r.routeId ?? routeIdFromPath(r.path);
    const covers = specIndex.specs.filter((s) => s.coverage.covers.includes(id));
    const hasAny = covers.length > 0;
    const hasUnit = covers.some((s) => isUnitKind(s));
    const hasIntegration = covers.some((s) => isIntegrationKind(s));
    const hasE2E = covers.some((s) => isE2EKind(s));
    if (hasUnit) bySpecKind.unit += 1;
    if (hasIntegration) bySpecKind.integration += 1;
    if (hasE2E) bySpecKind.e2e += 1;
    if (hasAny) bySpecKind.any += 1;
  }

  // ── contracts (filesystem walk + boundary probe) ──
  const contractFiles = findContractFilesFiltered(repoRoot, options);
  const contractMetrics = await computeContractCoverage(
    repoRoot,
    contractFiles,
    specIndex,
    routeNodes,
    options.skipBoundaryProbe === true,
  );

  // ── invariants ──
  const invariantState = computeInvariants(routeNodes, graph, specIndex);

  // ── topGaps ──
  const topGaps = buildTopGaps({
    routeNodes,
    specIndex,
    contractMetrics,
    invariantState,
    graph,
  });

  return {
    routes: {
      total: routeNodes.length,
      withUnitSpec: bySpecKind.unit,
      withIntegrationSpec: bySpecKind.integration,
      withE2ESpec: bySpecKind.e2e,
      withAnyKindOfSpec: bySpecKind.any,
    },
    contracts: {
      total: contractMetrics.total,
      withBoundaryCoverage: contractMetrics.withBoundaryCoverage,
      withPartialBoundary: contractMetrics.withPartialBoundary,
      withNoBoundary: contractMetrics.withNoBoundary,
    },
    invariants: invariantState,
    topGaps,
    graphVersion,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// contract coverage
// ──────────────────────────────────────────────────────────────────────────

interface ContractCoverageResult {
  total: number;
  withBoundaryCoverage: number;
  withPartialBoundary: number;
  withNoBoundary: number;
  /** Per-contract detail so buildTopGaps can surface names. */
  detail: Array<{
    file: string;
    name: string;
    state: "covered" | "partial" | "missing";
    probesFound: number;
    probesTotal: number;
  }>;
}

async function computeContractCoverage(
  repoRoot: string,
  contractFiles: string[],
  specIndex: SpecIndex,
  routeNodes: Array<Extract<InteractionNode, { kind: "route" }>>,
  skipBoundaryProbe: boolean,
): Promise<ContractCoverageResult> {
  const detail: ContractCoverageResult["detail"] = [];
  let covered = 0;
  let partial = 0;
  let missing = 0;

  for (const cf of contractFiles) {
    const name = contractBaseName(cf);
    const routePattern = contractInferredRoute(cf);
    const routeId = routeIdFromPath(routePattern);
    const coveringSpecs = specIndex.specs.filter((s) => s.coverage.covers.includes(routeId));

    if (skipBoundaryProbe) {
      // When caller opts out of probe generation, we classify purely on
      // presence of any spec.
      const state = coveringSpecs.length === 0 ? "missing" : "covered";
      if (state === "covered") covered += 1;
      else missing += 1;
      detail.push({ file: cf, name, state, probesFound: 0, probesTotal: 0 });
      continue;
    }

    // Generate probes for the contract.
    let probeResult;
    try {
      probeResult = await generateProbes({
        repoRoot,
        contractFile: resolve(repoRoot, cf),
        depth: 1,
      });
    } catch {
      detail.push({ file: cf, name, state: "missing", probesFound: 0, probesTotal: 0 });
      missing += 1;
      continue;
    }
    const probes = probeResult.probes;
    const probesTotal = probes.length;

    if (probesTotal === 0) {
      // Contract has no fields we can probe — treat as N/A (covered).
      detail.push({ file: cf, name, state: "covered", probesFound: 0, probesTotal: 0 });
      covered += 1;
      continue;
    }

    // Load covering spec source.
    const sources: string[] = [];
    for (const s of coveringSpecs) {
      const abs = join(repoRoot, s.path);
      if (existsSync(abs)) {
        try {
          sources.push(readFileSync(abs, "utf8"));
        } catch {
          // ignore
        }
      }
    }
    const hayStack = sources.join("\n");

    let probesFound = 0;
    for (const p of probes) {
      if (probeMentioned(hayStack, p.value, p.category)) probesFound += 1;
    }

    let state: "covered" | "partial" | "missing";
    if (probesFound === 0) state = "missing";
    else if (probesFound >= probesTotal) state = "covered";
    else state = "partial";

    if (state === "covered") covered += 1;
    else if (state === "partial") partial += 1;
    else missing += 1;

    detail.push({ file: cf, name, state, probesFound, probesTotal });
  }

  return {
    total: contractFiles.length,
    withBoundaryCoverage: covered,
    withPartialBoundary: partial,
    withNoBoundary: missing,
    detail,
  };
}

function probeMentioned(source: string, value: unknown, category: string): boolean {
  // Category match — describe/it titles often include "boundary", "empty", etc.
  const catNeedle = category.replace(/_/g, " ").toLowerCase();
  if (source.toLowerCase().includes(catNeedle)) return true;
  if (source.toLowerCase().includes(category.toLowerCase())) return true;

  // Literal value match — avoid trivially short strings that would
  // match anywhere.
  if (typeof value === "string") {
    if (value.length >= 3 && source.includes(value)) return true;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    const s = String(value);
    if (s.length >= 2 && source.includes(s)) return true;
  } else if (value === null) {
    if (/\bnull\b/.test(source)) return true;
  } else if (value === undefined) {
    if (/\bundefined\b/.test(source)) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// invariants
// ──────────────────────────────────────────────────────────────────────────

type InvariantState = "covered" | "partial" | "missing";
type InvariantKey = "csrf" | "rate_limit" | "session" | "auth" | "i18n";

const INVARIANT_TOKENS: Record<InvariantKey, string[]> = {
  csrf: ["csrf", "_csrf"],
  rate_limit: ["rate limit", "rate-limit", "rateLimit", "429"],
  session: ["session", "createTestSession", "sid"],
  auth: ["auth", "login", "requireLogin", "requireUser"],
  i18n: ["i18n", "locale", "translation"],
};

function computeInvariants(
  routeNodes: Array<Extract<InteractionNode, { kind: "route" }>>,
  graph: InteractionGraph,
  specIndex: SpecIndex,
): CoverageMetrics["invariants"] {
  // Which middleware names appear somewhere.
  const fillings = graph.nodes.filter(
    (n): n is Extract<InteractionNode, { kind: "filling" }> => n.kind === "filling",
  );

  const invariantPresent: Record<InvariantKey, boolean> = {
    csrf: fillings.some((f) => f.middlewareNames.some((m) => /csrf/i.test(m))),
    rate_limit: fillings.some((f) =>
      f.middlewareNames.some((m) => /rate[-_]?limit/i.test(m)),
    ),
    session: fillings.some((f) => f.middlewareNames.some((m) => /session/i.test(m))),
    auth: fillings.some((f) =>
      f.middlewareNames.some((m) => /auth|requireLogin|requireUser/i.test(m)),
    ),
    i18n: fillings.some((f) => f.middlewareNames.some((m) => /i18n|locale/i.test(m))),
  };

  const out: CoverageMetrics["invariants"] = {
    csrf: "missing",
    rate_limit: "missing",
    session: "missing",
    auth: "missing",
    i18n: "missing",
  };

  const allSpecs = specIndex.specs;

  for (const key of Object.keys(INVARIANT_TOKENS) as InvariantKey[]) {
    if (!invariantPresent[key]) {
      // No middleware declared — invariant doesn't apply. Mark as
      // "covered" to indicate it's not a gap.
      out[key] = "covered";
      continue;
    }
    const hits = specHits(allSpecs, INVARIANT_TOKENS[key]);
    if (hits === 0) {
      out[key] = "missing";
    } else {
      // Promote to partial unless we see multiple hits across specs.
      out[key] = hits >= 2 ? "covered" : "partial";
    }
  }

  return out;
}

function specHits(specs: IndexedSpec[], tokens: string[]): number {
  let hits = 0;
  for (const s of specs) {
    for (const tok of tokens) {
      if (s.path.toLowerCase().includes(tok.toLowerCase())) {
        hits += 1;
        break;
      }
    }
  }
  return hits;
}

// ──────────────────────────────────────────────────────────────────────────
// topGaps
// ──────────────────────────────────────────────────────────────────────────

function buildTopGaps(params: {
  routeNodes: Array<Extract<InteractionNode, { kind: "route" }>>;
  specIndex: SpecIndex;
  contractMetrics: ContractCoverageResult;
  invariantState: CoverageMetrics["invariants"];
  graph: InteractionGraph;
}): CoverageMetrics["topGaps"] {
  const { routeNodes, specIndex, contractMetrics, invariantState, graph } = params;
  const gaps: CoverageMetrics["topGaps"] = [];

  const fillings = graph.nodes.filter(
    (n): n is Extract<InteractionNode, { kind: "filling" }> => n.kind === "filling",
  );

  // 1. Routes without any covering spec.
  for (const r of routeNodes) {
    const id = r.routeId ?? routeIdFromPath(r.path);
    const covers = specIndex.specs.filter((s) => s.coverage.covers.includes(id));
    if (covers.length === 0) {
      const severity = computeRouteSeverity(r, fillings);
      gaps.push({
        kind: "route_without_spec",
        target: id,
        severity,
        reason: `route ${r.path} has no @ate-covers spec or direct import`,
      });
    }
  }

  // 2. Contracts with missing / partial boundary coverage.
  for (const d of contractMetrics.detail) {
    if (d.state === "missing") {
      gaps.push({
        kind: "contract_without_boundary",
        target: d.name,
        severity: "high",
        reason: `contract ${d.name} has ${d.probesTotal} probe(s), 0 found in any spec`,
      });
    } else if (d.state === "partial") {
      gaps.push({
        kind: "contract_without_boundary",
        target: d.name,
        severity: "medium",
        reason: `contract ${d.name}: ${d.probesFound}/${d.probesTotal} probes covered`,
      });
    }
  }

  // 3. Invariants missing.
  for (const [name, state] of Object.entries(invariantState) as Array<[InvariantKey, InvariantState]>) {
    if (state === "missing") {
      gaps.push({
        kind: "invariant_missing",
        target: name,
        severity: "high",
        reason: `middleware ${name} detected but no matching test found`,
      });
    } else if (state === "partial") {
      gaps.push({
        kind: "invariant_missing",
        target: name,
        severity: "medium",
        reason: `middleware ${name} has some tests but not exhaustive`,
      });
    }
  }

  // Sort: high → medium → low.
  const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return gaps;
}

function computeRouteSeverity(
  route: Extract<InteractionNode, { kind: "route" }>,
  fillings: Array<Extract<InteractionNode, { kind: "filling" }>>,
): "high" | "medium" | "low" {
  const routeId = route.routeId ?? routeIdFromPath(route.path);
  const filling = fillings.find((f) => f.routeId === routeId);
  const mw = filling?.middlewareNames ?? [];
  const authed = mw.some((m) => /session|auth/i.test(m));
  const admin =
    route.path.includes("/admin") ||
    route.path.includes("/internal") ||
    route.path.includes("/_");
  if (admin) return "low";
  if (authed) return "medium";
  return "high";
}

// ──────────────────────────────────────────────────────────────────────────
// spec-kind heuristics
// ──────────────────────────────────────────────────────────────────────────

function isUnitKind(s: IndexedSpec): boolean {
  return (
    /\.test\.tsx?$/.test(s.path) &&
    !/\/e2e\//.test(s.path) &&
    !/integration/i.test(s.path)
  );
}

function isIntegrationKind(s: IndexedSpec): boolean {
  return /integration/i.test(s.path) || /\/tests\/server\//.test(s.path);
}

function isE2EKind(s: IndexedSpec): boolean {
  return /\/e2e\//.test(s.path) || /\.spec\.tsx?$/.test(s.path);
}

// ──────────────────────────────────────────────────────────────────────────
// filesystem helpers
// ──────────────────────────────────────────────────────────────────────────

function findContractFilesFiltered(
  repoRoot: string,
  options: ComputeCoverageOptions,
): string[] {
  const absFiles = fg.sync(["**/*.contract.ts", "**/*.contract.tsx"], {
    cwd: repoRoot,
    absolute: true,
    ignore: ["**/node_modules/**", "**/.mandu/**", "**/dist/**"],
  });

  const rel = absFiles.map((abs) => relative(repoRoot, abs).replace(/\\/g, "/"));
  if (options.scope === "contract" && options.target) {
    const target = options.target.toLowerCase().replace(/\.contract\.(ts|tsx)$/, "");
    return rel.filter((f) => {
      const base = contractBaseName(f).toLowerCase();
      return base === target || f.toLowerCase().includes(target);
    });
  }
  return rel;
}

function contractBaseName(relFile: string): string {
  const base = relFile.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.contract\.(ts|tsx)$/, "");
}

function contractInferredRoute(relFile: string): string {
  const name = contractBaseName(relFile);
  const parts = name.split("-").map((p) => (p.startsWith("$") ? `:${p.slice(1)}` : p));
  return "/" + parts.join("/");
}

function loadGraph(repoRoot: string): InteractionGraph | null {
  const paths = getAtePaths(repoRoot);
  if (!fileExists(paths.interactionGraphPath)) return null;
  try {
    return JSON.parse(readFileSync(paths.interactionGraphPath, "utf8")) as InteractionGraph;
  } catch {
    return null;
  }
}

function emptyMetrics(graphVersion: string): CoverageMetrics {
  return {
    routes: {
      total: 0,
      withUnitSpec: 0,
      withIntegrationSpec: 0,
      withE2ESpec: 0,
      withAnyKindOfSpec: 0,
    },
    contracts: {
      total: 0,
      withBoundaryCoverage: 0,
      withPartialBoundary: 0,
      withNoBoundary: 0,
    },
    invariants: {
      csrf: "missing",
      rate_limit: "missing",
      session: "missing",
      auth: "missing",
      i18n: "missing",
    },
    topGaps: [],
    graphVersion,
  };
}

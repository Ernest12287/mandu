/**
 * Phase A.1 — Agent context builder.
 *
 * Consumes the artifact of `extract()` plus the in-memory spec index
 * and produces the JSON blob returned by `mandu_ate_context`
 * (see docs/ate/roadmap-v2-agent-native.md §4.1).
 *
 * Scope:
 *   "project"  → high-level summary of every route + contract
 *   "route"    → single-route deep view (contract + middleware +
 *                fixtures + existing specs + related routes)
 *   "filling"  → filling-focused view (middleware chain + actions +
 *                handler methods)
 *   "contract" → contract-focused view (request/response + examples)
 *
 * Design constraints:
 *   - Deterministic (no eval, no network).
 *   - Tolerates missing inputs — returns `{found: false, ...}` rather
 *     than throwing when an id is not in the graph.
 *   - Never allocates more than O(|graph| + |specs|).
 *
 * This module is intentionally free of ts-morph — we consume the
 * already-extracted graph + raw source only where needed (contract
 * examples live in source text).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import fg from "fast-glob";
import type {
  InteractionGraph,
  InteractionNode,
  StaticParamSample,
} from "./types";
import type { IndexedSpec, SpecIndex } from "./spec-indexer";
import { indexSpecs, specsForRouteId } from "./spec-indexer";
import { routeIdFromPath } from "./extractor-utils";
import {
  parseContractFile,
  findContractForRoute,
  type ParsedContract,
} from "./contract-parser";
import { readContractExamples } from "./extractor";
import { getAtePaths, fileExists } from "./fs";
import { graphVersionFromGraph } from "./graph-version";

// ────────────────────────────────────────────────────────────────────────────
// Public types — shape returned by `buildRouteContext` etc.
// ────────────────────────────────────────────────────────────────────────────

export type ContextScope = "project" | "route" | "filling" | "contract";

export interface ContextRequest {
  scope: ContextScope;
  /** Route id, filling id, or contract name. */
  id?: string;
  /** Route pattern match — e.g. "/api/signup". */
  route?: string;
}

export interface MiddlewareInfo {
  /** Canonical middleware name — e.g. "session", "csrf", "rate-limit". */
  name: string;
  /** Raw identifier as used in the source file (e.g. "withSession"). */
  identifier: string;
  /** Static options if the identifier is a known factory with literal args. */
  options?: Record<string, unknown>;
  /** Best-effort path to the middleware definition file, if resolvable. */
  file?: string;
}

export interface ContractMethodExample {
  name: string;
  /** Raw literal source (string) — agents may paste this. */
  literal: string;
}

export interface ContractMethodView {
  /** e.g. "POST" for request side, "201" for response side. */
  key: string;
  /** "request" or "response". */
  kind: "request" | "response";
  bodyFields?: Array<{ name: string; kind: string; optional: boolean; minLength?: number }>;
  topLevelKeys?: Array<{ name: string; kind: string; optional: boolean; minLength?: number }>;
  examples: ContractMethodExample[];
}

export interface ContractView {
  file: string;
  /** Route pattern inferred from the contract file name. */
  inferredRoute: string;
  methods: ContractMethodView[];
}

export interface FixtureRecommendations {
  /**
   * The `@mandujs/core/testing` helper names that agents should prefer
   * for this route. Derived from the middleware chain + contract
   * surface — e.g. `session` middleware → `createTestSession`.
   */
  recommended: string[];
  /**
   * Short human-readable rationale per recommendation (keyed by name).
   */
  rationale: Record<string, string>;
  /**
   * Exemplar file the LLM should peek at before emitting code. Currently
   * always a best-guess into `packages/core/src/filling/__tests__`.
   */
  exemplarsPath: string;
}

export interface ExistingSpecView {
  path: string;
  kind: "user-written" | "ate-generated";
  lastRun: string | null;
  status: "pass" | "fail" | "skipped" | null;
  outdated?: boolean;
}

export interface RelatedRouteView {
  id: string;
  pattern: string;
  /** Why this route is related — "sibling", "ui-entry-point", etc. */
  relationship: string;
}

export interface RouteContextBlob {
  scope: "route";
  found: true;
  /** Phase A.2 — freshness hash stamped by `buildContext`. */
  graphVersion?: string;
  route: {
    id: string;
    pattern: string;
    kind: "api" | "page";
    file: string;
    isRedirect: boolean;
    methods?: string[];
    staticParams?: StaticParamSample[];
  };
  contract: ContractView | null;
  middleware: MiddlewareInfo[];
  guard: {
    preset: string;
    tags: string[];
    suggestedSelectors: string[];
  };
  fixtures: FixtureRecommendations;
  existingSpecs: ExistingSpecView[];
  relatedRoutes: RelatedRouteView[];
  /** Slot / island / form companion surfaces for this route. */
  companions: {
    slots: Array<{ name: string; file: string }>;
    islands: Array<{ name: string; file: string }>;
    forms: Array<{ action?: string; method?: string }>;
    actions: Array<{ name: string; file: string }>;
  };
}

export interface FillingContextBlob {
  scope: "filling";
  found: true;
  /** Phase A.2 — freshness hash stamped by `buildContext`. */
  graphVersion?: string;
  filling: {
    id: string;
    file: string;
    routeId: string;
    methods: string[];
    actions: string[];
  };
  middleware: MiddlewareInfo[];
  contract: ContractView | null;
  existingSpecs: ExistingSpecView[];
  fixtures: FixtureRecommendations;
}

export interface ContractContextBlob {
  scope: "contract";
  found: true;
  /** Phase A.2 — freshness hash stamped by `buildContext`. */
  graphVersion?: string;
  contract: ContractView;
  usedByRoutes: Array<{ id: string; pattern: string }>;
}

export interface ProjectContextBlob {
  scope: "project";
  /** Phase A.2 — freshness hash stamped by `buildContext`. */
  graphVersion?: string;
  summary: {
    routes: number;
    apiRoutes: number;
    pageRoutes: number;
    fillings: number;
    slots: number;
    islands: number;
    forms: number;
    contracts: number;
    existingSpecs: number;
  };
  routes: Array<{
    id: string;
    pattern: string;
    kind: "api" | "page";
    methods?: string[];
    hasContract: boolean;
    hasIsland: boolean;
    existingSpecCount: number;
  }>;
  /** Spec files without a resolved coverage target — candidates for tagging. */
  unmappedSpecs: string[];
}

export interface NotFoundBlob {
  scope: ContextScope;
  found: false;
  /** Phase A.2 — freshness hash stamped by `buildContext`. */
  graphVersion?: string;
  reason: string;
  /** Suggested alternative ids that the caller might have meant. */
  suggestions: string[];
}

export type ContextBlob =
  | RouteContextBlob
  | FillingContextBlob
  | ContractContextBlob
  | ProjectContextBlob
  | NotFoundBlob;

// ────────────────────────────────────────────────────────────────────────────
// Middleware identifier → canonical name table.
//
// The extractor captures raw identifiers ("withSession", "csrf",
// "rateLimitMiddleware"). The context builder normalizes these to a
// stable canonical name the agent can key off. Unrecognized
// identifiers fall through with `name === identifier`.
// ────────────────────────────────────────────────────────────────────────────

const MIDDLEWARE_ALIASES: Array<{ pattern: RegExp; name: string; rationale: string }> = [
  { pattern: /session/i, name: "session", rationale: "session middleware detected — agents should call createTestSession fixture" },
  { pattern: /csrf/i, name: "csrf", rationale: "csrf middleware detected — tests must set the _csrf body field or x-csrf-token header" },
  { pattern: /rate[-_]?limit/i, name: "rate-limit", rationale: "rate-limit middleware detected — agents should reset the limiter between test cases" },
  { pattern: /cors/i, name: "cors", rationale: "cors middleware detected — preflight OPTIONS case may be relevant" },
  { pattern: /auth|requireLogin|requireUser/i, name: "auth", rationale: "auth guard detected — tests need a pre-authenticated session" },
  { pattern: /helmet|secure[-_]?headers/i, name: "secure-headers", rationale: "secure-headers middleware detected — skip assertions on Content-Security-Policy unless intentional" },
];

function canonicalizeMiddleware(identifier: string): { name: string; rationale?: string } {
  for (const entry of MIDDLEWARE_ALIASES) {
    if (entry.pattern.test(identifier)) {
      return { name: entry.name, rationale: entry.rationale };
    }
  }
  return { name: identifier };
}

// ────────────────────────────────────────────────────────────────────────────
// Core entrypoint.
// ────────────────────────────────────────────────────────────────────────────

export interface BuildContextOptions {
  /** Inject a pre-built graph (for tests). Default: read from disk. */
  graph?: InteractionGraph;
  /** Inject a pre-built spec index (for tests). Default: scan repo. */
  specIndex?: SpecIndex;
  /** Override guard preset detection (default: read mandu.config.ts). */
  guardPreset?: string;
}

export function buildContext(
  repoRoot: string,
  request: ContextRequest,
  options: BuildContextOptions = {},
): ContextBlob {
  const graph = options.graph ?? loadGraph(repoRoot);
  if (!graph) {
    return {
      scope: request.scope,
      found: false,
      reason: `Interaction graph not found. Run extract() first.`,
      suggestions: [],
    };
  }
  const specIndex = options.specIndex ?? indexSpecs(repoRoot);
  const guardPreset = options.guardPreset ?? detectGuardPreset(repoRoot);
  const graphVersion = graphVersionFromGraph(graph);

  let blob: ContextBlob;
  switch (request.scope) {
    case "project":
      blob = buildProjectContext(graph, specIndex);
      break;
    case "route":
      blob = buildRouteContext(repoRoot, graph, specIndex, guardPreset, request);
      break;
    case "filling":
      blob = buildFillingContext(repoRoot, graph, specIndex, request);
      break;
    case "contract":
      blob = buildContractContext(repoRoot, graph, request);
      break;
    default:
      blob = {
        scope: request.scope,
        found: false,
        reason: `Unknown scope: ${request.scope}`,
        suggestions: ["project", "route", "filling", "contract"],
      };
  }

  // Phase A.2 — stamp every response with the freshness hash so
  // downstream agents can invalidate caches when routes/contracts
  // shift underneath them. This mutates the returned object in place
  // because the union of blob types all accept `graphVersion`.
  (blob as { graphVersion?: string }).graphVersion = graphVersion;
  return blob;
}

// ────────────────────────────────────────────────────────────────────────────
// project scope
// ────────────────────────────────────────────────────────────────────────────

function buildProjectContext(graph: InteractionGraph, specIndex: SpecIndex): ProjectContextBlob {
  const routeNodes = graph.nodes.filter((n) => n.kind === "route");
  const routes = routeNodes.map((n) => {
    if (n.kind !== "route") throw new Error("unreachable");
    const coverCount = specIndex.specs.filter((s) =>
      s.coverage.covers.includes(n.routeId ?? routeIdFromPath(n.path)),
    ).length;
    return {
      id: n.routeId ?? routeIdFromPath(n.path),
      pattern: n.path,
      kind: (n.methods && n.methods.length > 0 ? "api" : "page") as "api" | "page",
      methods: n.methods,
      hasContract: Boolean(n.hasContract),
      hasIsland: Boolean(n.hasIsland),
      existingSpecCount: coverCount,
    };
  });

  const apiRoutes = routes.filter((r) => r.kind === "api").length;
  const pageRoutes = routes.length - apiRoutes;

  const unmappedSpecs = specIndex.specs
    .filter((s) => s.coverage.covers.length === 0)
    .map((s) => s.path);

  return {
    scope: "project",
    summary: {
      routes: graph.stats.routes,
      apiRoutes,
      pageRoutes,
      fillings: graph.stats.fillings ?? 0,
      slots: graph.stats.slots ?? 0,
      islands: graph.stats.islands ?? 0,
      forms: graph.stats.forms ?? 0,
      contracts: graph.nodes.filter((n) => n.kind === "route" && n.hasContract).length,
      existingSpecs: specIndex.specs.length,
    },
    routes,
    unmappedSpecs,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// route scope
// ────────────────────────────────────────────────────────────────────────────

function buildRouteContext(
  repoRoot: string,
  graph: InteractionGraph,
  specIndex: SpecIndex,
  guardPreset: string,
  request: ContextRequest,
): RouteContextBlob | NotFoundBlob {
  const routeNode = findRouteNode(graph, request);
  if (!routeNode) {
    return {
      scope: "route",
      found: false,
      reason: `No route matches id=${request.id ?? "<none>"} route=${request.route ?? "<none>"}`,
      suggestions: graph.nodes
        .filter((n) => n.kind === "route")
        .slice(0, 5)
        .map((n) => (n.kind === "route" ? n.routeId ?? n.id : ""))
        .filter(Boolean),
    };
  }

  const routeId = routeNode.routeId ?? routeIdFromPath(routeNode.path);
  const routeAbs = join(repoRoot, routeNode.file);

  // 1. Contract — prefer colocated match, fall back to inferred-route global search.
  const contract = loadContract(repoRoot, routeNode.path, routeAbs);

  // 2. Middleware — pulled from the sibling filling node if one exists,
  //    otherwise scanned inline from the route file.
  const fillingNode = graph.nodes.find(
    (n): n is Extract<InteractionNode, { kind: "filling" }> =>
      n.kind === "filling" && n.routeId === routeId,
  );
  const middleware = buildMiddlewareInfos(repoRoot, fillingNode?.middlewareNames ?? []);

  // 3. Guard — preset + route tags (api/public/authenticated inferred
  //    from the middleware chain).
  const tags = inferGuardTags(routeNode, middleware);

  // 4. Fixtures — derived from middleware chain.
  const fixtures = recommendFixtures(middleware, Boolean(contract));

  // 5. Existing specs for this route.
  const existingSpecs = specsForRouteId(specIndex, routeId).map(toExistingSpecView);

  // 6. Related routes — siblings under the same parent prefix, plus any
  //    route whose id starts with the same first segment.
  const relatedRoutes = buildRelatedRoutes(graph, routeNode);

  // 7. Companion nodes — slot/island/form/action filtered by routeId.
  const companions = collectCompanions(graph, routeId);

  return {
    scope: "route",
    found: true,
    route: {
      id: routeId,
      pattern: routeNode.path,
      kind: routeNode.methods && routeNode.methods.length > 0 ? "api" : "page",
      file: routeNode.file,
      isRedirect: Boolean(routeNode.isRedirect),
      ...(routeNode.methods ? { methods: routeNode.methods } : {}),
      ...(routeNode.staticParams ? { staticParams: routeNode.staticParams } : {}),
    },
    contract,
    middleware,
    guard: {
      preset: guardPreset,
      tags,
      suggestedSelectors: [`[data-route-id=${routeId}]`],
    },
    fixtures,
    existingSpecs,
    relatedRoutes,
    companions,
  };
}

function findRouteNode(
  graph: InteractionGraph,
  request: ContextRequest,
): Extract<InteractionNode, { kind: "route" }> | null {
  const routes = graph.nodes.filter(
    (n): n is Extract<InteractionNode, { kind: "route" }> => n.kind === "route",
  );
  if (request.route) {
    const hit = routes.find((n) => n.path === request.route);
    if (hit) return hit;
  }
  if (request.id) {
    const hit = routes.find((n) => {
      const id = n.routeId ?? routeIdFromPath(n.path);
      return id === request.id || n.id === request.id || n.path === request.id;
    });
    if (hit) return hit;
  }
  return null;
}

function loadContract(repoRoot: string, routePath: string, routeAbs: string): ContractView | null {
  const parsed = findContractForRoute(repoRoot, routePath, routeAbs);
  if (!parsed) return null;
  return toContractView(parsed);
}

function toContractView(parsed: ParsedContract): ContractView {
  const examples = readContractExamples(parsed.file);
  const methods: ContractMethodView[] = [];

  for (const req of parsed.requests) {
    methods.push({
      key: req.method,
      kind: "request",
      bodyFields: req.bodyFields,
      examples: examples
        .filter((e) => e.kind === "request" && e.method === req.method)
        .map((e) => ({ name: e.name, literal: e.literal })),
    });
  }

  for (const resp of parsed.responses) {
    methods.push({
      key: String(resp.status),
      kind: "response",
      topLevelKeys: resp.topLevelKeys,
      examples: examples
        .filter((e) => e.kind === "response" && e.status === resp.status)
        .map((e) => ({ name: e.name, literal: e.literal })),
    });
  }

  return {
    file: parsed.file.replace(/\\/g, "/"),
    inferredRoute: parsed.inferredRoute,
    methods,
  };
}

function buildMiddlewareInfos(
  repoRoot: string,
  identifiers: string[],
): MiddlewareInfo[] {
  return identifiers.map((identifier) => {
    const { name, rationale: _rationale } = canonicalizeMiddleware(identifier);
    const file = findMiddlewareFile(repoRoot, name);
    return {
      name,
      identifier,
      ...(file ? { file } : {}),
    };
  });
}

/**
 * Best-effort probe for a middleware definition file. Checks common
 * conventional paths under `src/lib/`, `middleware/`, and
 * `packages/core/src/middleware/`. Returns repo-relative POSIX path
 * or undefined.
 */
function findMiddlewareFile(repoRoot: string, name: string): string | undefined {
  const candidates = [
    `src/lib/${name}.ts`,
    `src/middleware/${name}.ts`,
    `middleware/${name}/index.ts`,
    `middleware/${name}.ts`,
    `src/lib/auth.ts`,
  ];
  for (const c of candidates) {
    const abs = join(repoRoot, c);
    if (existsSync(abs)) return c;
  }
  return undefined;
}

function inferGuardTags(
  routeNode: Extract<InteractionNode, { kind: "route" }>,
  middleware: MiddlewareInfo[],
): string[] {
  const tags = new Set<string>();
  if (routeNode.methods && routeNode.methods.length > 0) tags.add("api");
  else tags.add("page");

  const middlewareNames = new Set(middleware.map((m) => m.name));
  if (middlewareNames.has("session") || middlewareNames.has("auth")) tags.add("authenticated");
  else tags.add("public");

  if (middlewareNames.has("csrf")) tags.add("csrf-protected");
  if (middlewareNames.has("rate-limit")) tags.add("rate-limited");
  if (routeNode.isRedirect) tags.add("redirect");

  return [...tags];
}

function recommendFixtures(
  middleware: MiddlewareInfo[],
  hasContract: boolean,
): FixtureRecommendations {
  const recommended: string[] = [];
  const rationale: Record<string, string> = {};

  const middlewareNames = new Set(middleware.map((m) => m.name));

  if (middlewareNames.has("session") || middlewareNames.has("auth")) {
    recommended.push("createTestSession");
    rationale.createTestSession =
      "Route uses session/auth middleware — pre-sign a session cookie instead of walking through login.";
  }

  if (middlewareNames.has("csrf")) {
    recommended.push("createTestSession");
    rationale.createTestSession = (rationale.createTestSession ?? "") +
      (rationale.createTestSession ? " " : "") +
      "csrf middleware also requires a session cookie + matching _csrf field.";
  }

  recommended.push("createTestDb");
  rationale.createTestDb =
    "Use in-memory bun:sqlite from @mandujs/core/testing — never mock the database.";

  if (hasContract) {
    recommended.push("expectContract");
    rationale.expectContract =
      "Contract is defined — assert the response shape with expectContract instead of JSON.stringify.";
  }

  if (middlewareNames.has("rate-limit")) {
    recommended.push("testFilling");
    rationale.testFilling =
      "Loop testFilling calls to exercise rate-limit (returns 429 after quota).";
  } else if (!recommended.includes("testFilling")) {
    recommended.push("testFilling");
    rationale.testFilling =
      "Prefer testFilling over hand-rolled Request — it injects CSRF + action headers correctly.";
  }

  // De-dupe while preserving order.
  const seen = new Set<string>();
  const deduped = recommended.filter((r) => {
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });

  return {
    recommended: deduped,
    rationale,
    exemplarsPath: "packages/core/src/filling/__tests__/action.test.ts",
  };
}

function buildRelatedRoutes(
  graph: InteractionGraph,
  target: Extract<InteractionNode, { kind: "route" }>,
): RelatedRouteView[] {
  const targetId = target.routeId ?? routeIdFromPath(target.path);
  const targetSegments = target.path.split("/").filter(Boolean);
  const firstSegment = targetSegments[0] ?? "";

  const result: RelatedRouteView[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "route") continue;
    const id = node.routeId ?? routeIdFromPath(node.path);
    if (id === targetId) continue;

    const otherSegments = node.path.split("/").filter(Boolean);
    const otherFirst = otherSegments[0] ?? "";

    // "sibling" = same first segment (e.g. /api/signup ↔ /api/login)
    if (firstSegment && firstSegment === otherFirst) {
      result.push({
        id,
        pattern: node.path,
        relationship: "sibling",
      });
      continue;
    }

    // "ui-entry-point" = page that links to the target. For API routes
    // we look for a page under `/<tail>` matching the API tail.
    // e.g. /api/signup ↔ /signup
    if (target.methods && target.methods.length > 0 && targetSegments[0] === "api") {
      const apiTail = targetSegments.slice(1).join("/");
      const otherFlat = otherSegments.join("/");
      if (apiTail && apiTail === otherFlat) {
        result.push({
          id,
          pattern: node.path,
          relationship: "ui-entry-point",
        });
      }
    }
  }

  return result.slice(0, 20);
}

function collectCompanions(
  graph: InteractionGraph,
  routeId: string,
): RouteContextBlob["companions"] {
  const slots: Array<{ name: string; file: string }> = [];
  const islands: Array<{ name: string; file: string }> = [];
  const forms: Array<{ action?: string; method?: string }> = [];
  const actions: Array<{ name: string; file: string }> = [];

  for (const n of graph.nodes) {
    if (n.kind === "slot" && n.routeId === routeId) {
      slots.push({ name: n.name, file: n.file });
    } else if (n.kind === "island" && n.routeId === routeId) {
      islands.push({ name: n.name, file: n.file });
    } else if (n.kind === "form" && n.routeId === routeId) {
      forms.push({
        ...(n.action ? { action: n.action } : {}),
        ...(n.method ? { method: n.method } : {}),
      });
    } else if (n.kind === "action" && n.routeId === routeId) {
      actions.push({ name: n.name, file: n.file });
    }
  }

  return { slots, islands, forms, actions };
}

function toExistingSpecView(spec: IndexedSpec): ExistingSpecView {
  return {
    path: spec.path,
    kind: spec.kind,
    lastRun: spec.lastRun,
    status: spec.status,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// filling scope
// ────────────────────────────────────────────────────────────────────────────

function buildFillingContext(
  repoRoot: string,
  graph: InteractionGraph,
  specIndex: SpecIndex,
  request: ContextRequest,
): FillingContextBlob | NotFoundBlob {
  const fillingId = request.id ?? "";
  const fillingRouteId = fillingId.startsWith("filling:")
    ? fillingId.slice("filling:".length)
    : fillingId;

  const node = graph.nodes.find(
    (n): n is Extract<InteractionNode, { kind: "filling" }> =>
      n.kind === "filling" &&
      (n.id === fillingId || n.routeId === fillingRouteId),
  );

  if (!node) {
    const suggestions = graph.nodes
      .filter((n): n is Extract<InteractionNode, { kind: "filling" }> => n.kind === "filling")
      .slice(0, 5)
      .map((n) => n.id);
    return {
      scope: "filling",
      found: false,
      reason: `No filling found for id=${fillingId}`,
      suggestions,
    };
  }

  const routeNode = graph.nodes.find(
    (n): n is Extract<InteractionNode, { kind: "route" }> =>
      n.kind === "route" && (n.routeId === node.routeId),
  );
  const routeAbs = routeNode ? join(repoRoot, routeNode.file) : undefined;
  const contract =
    routeNode && routeAbs ? loadContract(repoRoot, routeNode.path, routeAbs) : null;
  const middleware = buildMiddlewareInfos(repoRoot, node.middlewareNames);
  const existingSpecs = specsForRouteId(specIndex, node.routeId).map(toExistingSpecView);
  const fixtures = recommendFixtures(middleware, Boolean(contract));

  return {
    scope: "filling",
    found: true,
    filling: {
      id: node.id,
      file: node.file,
      routeId: node.routeId,
      methods: node.methods,
      actions: node.actions,
    },
    middleware,
    contract,
    existingSpecs,
    fixtures,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// contract scope
// ────────────────────────────────────────────────────────────────────────────

function buildContractContext(
  repoRoot: string,
  graph: InteractionGraph,
  request: ContextRequest,
): ContractContextBlob | NotFoundBlob {
  const id = request.id ?? request.route;
  if (!id) {
    return {
      scope: "contract",
      found: false,
      reason: "contract scope requires `id` or `route`",
      suggestions: [],
    };
  }

  // Strategy: look up `*.contract.{ts,tsx}` anywhere in the repo whose
  // basename matches `id` (with or without the suffix), OR whose
  // inferredRoute equals `request.route`.
  const candidates = fg.sync(
    ["**/*.contract.ts", "**/*.contract.tsx"],
    { cwd: repoRoot, absolute: true, ignore: ["**/node_modules/**", "**/.mandu/**"] },
  );

  let matched: ParsedContract | null = null;
  for (const abs of candidates) {
    const parsed = parseContractFile(abs);
    if (!parsed) continue;
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const baseName = rel.split("/").pop() ?? "";
    const nameOnly = baseName.replace(/\.contract\.tsx?$/, "");
    if (
      nameOnly === id ||
      nameOnly.replace(/-/g, "/") === id ||
      parsed.inferredRoute === request.route ||
      parsed.inferredRoute === request.id
    ) {
      matched = parsed;
      break;
    }
  }

  if (!matched) {
    return {
      scope: "contract",
      found: false,
      reason: `No contract matches id=${id}`,
      suggestions: [],
    };
  }

  const contractView = toContractView(matched);
  const usedByRoutes: Array<{ id: string; pattern: string }> = [];
  for (const n of graph.nodes) {
    if (n.kind !== "route") continue;
    if (n.path === matched.inferredRoute) {
      usedByRoutes.push({
        id: n.routeId ?? routeIdFromPath(n.path),
        pattern: n.path,
      });
    }
  }

  return {
    scope: "contract",
    found: true,
    contract: contractView,
    usedByRoutes,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// misc helpers
// ────────────────────────────────────────────────────────────────────────────

function loadGraph(repoRoot: string): InteractionGraph | null {
  const paths = getAtePaths(repoRoot);
  if (!fileExists(paths.interactionGraphPath)) return null;
  try {
    const content = readFileSync(paths.interactionGraphPath, "utf8");
    return JSON.parse(content) as InteractionGraph;
  } catch {
    return null;
  }
}

/**
 * Read `mandu.config.ts` (or `.js`) and grep for `guard: { preset: "x" }`.
 * We avoid dynamic import because the config module may transitively
 * import runtime modules that aren't resolvable from the ATE worker.
 *
 * Returns the preset string on match, or `"mandu"` (the default).
 */
function detectGuardPreset(repoRoot: string): string {
  const candidates = ["mandu.config.ts", "mandu.config.js"];
  for (const rel of candidates) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      const source = readFileSync(abs, "utf8");
      const match = source.match(/preset\s*:\s*["']([^"']+)["']/);
      if (match) return match[1];
    } catch {
      // fall through
    }
  }
  return "mandu";
}

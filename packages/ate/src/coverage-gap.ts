import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAtePaths, readJson } from "./fs";
import type { InteractionGraph, InteractionEdge, InteractionNode } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoverageGapType = "route-transition" | "api-call" | "form-action" | "island-interaction";

export interface CoverageGap {
  type: CoverageGapType;
  from: string;
  to: string;
  /** Human-readable test scenario description */
  suggestion: string;
}

export interface CoverageGapResult {
  gaps: CoverageGap[];
  coveredEdges: number;
  totalEdges: number;
  coveragePercent: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Canonical key for an edge so we can compare graph edges to test coverage. */
function edgeKey(kind: string, from: string, to: string): string {
  return `${kind}::${from}::${to}`;
}

/** Derive the "to" target from an InteractionEdge. */
function edgeTarget(edge: InteractionEdge): string {
  switch (edge.kind) {
    case "navigate":
      return edge.to;
    case "openModal":
      return edge.modal;
    case "runAction":
      return edge.action;
    default:
      return "";
  }
}

/** Map edge kind to CoverageGapType. */
function edgeKindToGapType(kind: InteractionEdge["kind"]): CoverageGapType {
  switch (kind) {
    case "navigate":
      return "route-transition";
    case "openModal":
      return "island-interaction";
    case "runAction":
      return "form-action";
    default:
      return "route-transition";
  }
}

/**
 * Build a set of edge keys that are already covered by existing test specs.
 *
 * We scan all generated spec files under `tests/e2e/auto/` and extract route
 * references from test names and `page.goto` / `fetch` calls.  This is a
 * heuristic -- it does not guarantee perfect detection -- but it provides a
 * practical approximation for coverage gap analysis.
 */
function collectCoveredEdges(repoRoot: string): Set<string> {
  const covered = new Set<string>();
  const paths = getAtePaths(repoRoot);

  // Also check manual specs
  const specDirs = [paths.autoE2eDir, paths.manualE2eDir];

  for (const dir of specDirs) {
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".spec.ts") || f.endsWith(".test.ts"));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf8");

        // Extract routes referenced in goto or fetch calls
        //   page.goto(... + "/some/route")
        //   fetch(... + "/api/endpoint", ...)
        const routeRefs = new Set<string>();

        // Match string literals that look like route paths
        const routePattern = /["'`](\/[a-zA-Z0-9/_-]*)["'`]/g;
        let match: RegExpExecArray | null;
        while ((match = routePattern.exec(content)) !== null) {
          routeRefs.add(match[1]);
        }

        // For navigate coverage: look for pairs of routes within the same test
        // Heuristic: if a spec references routes A and B, assume the A->B
        // transition is tested.
        const refs = Array.from(routeRefs);
        for (let i = 0; i < refs.length; i++) {
          for (let j = 0; j < refs.length; j++) {
            if (i !== j) {
              covered.add(edgeKey("navigate", refs[i], refs[j]));
            }
          }
        }

        // Single-route coverage: if a spec references a route, mark basic
        // API / form-action edges originating from or targeting that route.
        for (const route of refs) {
          // If the spec does a POST / fetch with method, mark form-action
          if (content.includes("POST") && content.includes(route)) {
            covered.add(edgeKey("runAction", route, route));
          }
          // If the spec mentions fetch to an API route, mark api-call
          if (content.includes("fetch") && route.startsWith("/api/")) {
            covered.add(edgeKey("navigate", "", route));
            // Also cover from any page
            for (const other of refs) {
              if (other !== route) {
                covered.add(edgeKey("navigate", other, route));
              }
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return covered;
}

/**
 * Build a human-readable suggestion for an uncovered edge.
 */
function buildSuggestion(
  gapType: CoverageGapType,
  from: string,
  to: string,
  edgeSource?: string,
): string {
  switch (gapType) {
    case "route-transition":
      return from
        ? `Add a test that navigates from "${from}" to "${to}" and verifies the destination page loads correctly.`
        : `Add a test that verifies navigation to "${to}" works correctly.`;
    case "api-call":
      return `Add a test that calls the API endpoint "${to}"${from ? ` from page "${from}"` : ""} and validates the response status and body.`;
    case "form-action":
      return `Add a test that triggers the form action "${to}"${from ? ` on page "${from}"` : ""} and verifies the expected side effects.`;
    case "island-interaction":
      return `Add a test that opens the modal/island "${to}"${from ? ` from page "${from}"` : ""} and verifies it renders and can be dismissed.`;
    default:
      return `Add a test covering the interaction from "${from}" to "${to}".`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect coverage gaps by comparing the InteractionGraph edges against
 * existing test specs in `.mandu/ate/specs/` and `tests/e2e/`.
 */
export function detectCoverageGaps(repoRoot: string): CoverageGapResult {
  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }

  // 1. Load interaction graph
  const paths = getAtePaths(repoRoot);
  let graph: InteractionGraph;
  try {
    graph = readJson<InteractionGraph>(paths.interactionGraphPath);
  } catch {
    // No graph -- nothing to analyze
    return { gaps: [], coveredEdges: 0, totalEdges: 0, coveragePercent: 100 };
  }

  // 2. Enumerate all edges in the graph as canonical keys
  const allEdgeKeys = new Map<string, { edge: InteractionEdge; from: string; to: string }>();

  const edges = graph.edges ?? [];
  for (const edge of edges) {
    const from = edge.from ?? "";
    const to = edgeTarget(edge);
    if (!to) continue;
    const key = edgeKey(edge.kind, from, to);
    allEdgeKeys.set(key, { edge, from, to });
  }

  // Also create synthetic edges for API routes that should be reachable
  // from page routes (api-call gaps).
  const apiRoutes = graph.nodes.filter(
    (n): n is Extract<InteractionNode, { kind: "route" }> =>
      n.kind === "route" && (n.path.startsWith("/api/") || (n.methods !== undefined && n.methods.length > 0)),
  );
  const pageRoutes = graph.nodes.filter(
    (n): n is Extract<InteractionNode, { kind: "route" }> =>
      n.kind === "route" && !n.path.startsWith("/api/"),
  );

  // For each API route, if there is no explicit navigate edge from any page,
  // create a synthetic edge representing an uncovered api-call.
  for (const api of apiRoutes) {
    const hasInboundEdge = edges.some(
      (e) => e.kind === "navigate" && edgeTarget(e) === api.path,
    );
    if (!hasInboundEdge) {
      const syntheticKey = edgeKey("navigate", "", api.path);
      if (!allEdgeKeys.has(syntheticKey)) {
        allEdgeKeys.set(syntheticKey, {
          edge: { kind: "navigate", from: "", to: api.path, file: api.file, source: "synthetic" },
          from: "",
          to: api.path,
        });
      }
    }
  }

  // Also flag island routes that have no hydration test edge
  for (const page of pageRoutes) {
    if (page.hasIsland) {
      const key = edgeKey("island", page.path, page.path);
      if (!allEdgeKeys.has(key)) {
        allEdgeKeys.set(key, {
          edge: { kind: "navigate", from: page.path, to: page.path, file: page.file, source: "island-hydration" },
          from: page.path,
          to: page.path,
        });
      }
    }
  }

  if (allEdgeKeys.size === 0) {
    return { gaps: [], coveredEdges: 0, totalEdges: 0, coveragePercent: 100 };
  }

  const totalEdges = allEdgeKeys.size;

  // 3. Collect covered edges from existing specs
  const covered = collectCoveredEdges(repoRoot);

  // 4. Find gaps
  const gaps: CoverageGap[] = [];
  let coveredCount = 0;

  for (const [key, { edge, from, to }] of allEdgeKeys) {
    if (covered.has(key)) {
      coveredCount++;
      continue;
    }

    // Determine gap type
    let gapType = edgeKindToGapType(edge.kind);

    // Refine: if the target is an API route, reclassify as api-call
    if (to.startsWith("/api/") && gapType === "route-transition") {
      gapType = "api-call";
    }

    gaps.push({
      type: gapType,
      from,
      to,
      suggestion: buildSuggestion(gapType, from, to, edge.source),
    });
  }

  const coveragePercent = totalEdges === 0 ? 100 : Math.round((coveredCount / totalEdges) * 100);

  return {
    gaps,
    coveredEdges: coveredCount,
    totalEdges,
    coveragePercent,
  };
}

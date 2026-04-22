import type { InteractionGraph, OracleLevel } from "./types";
import { getAtePaths, readJson, writeJson } from "./fs";

export type ScenarioKind = "route-smoke" | "api-smoke" | "ssr-verify" | "island-hydration" | "sse-stream" | "form-action";

export interface GeneratedScenario {
  id: string;
  kind: ScenarioKind;
  route: string;
  methods?: string[];
  hasIsland?: boolean;
  /**
   * Route performs a page-level redirect on load (meta-refresh or
   * server-side redirect()). ssr-verify specs for redirect routes avoid
   * calling page.content() immediately after goto (issue #224).
   */
  isRedirect?: boolean;
  oracleLevel: OracleLevel;
}

export interface ScenarioBundle {
  schemaVersion: 1;
  generatedAt: string;
  oracleLevel: OracleLevel;
  scenarios: GeneratedScenario[];
}

const VALID_ORACLE_LEVELS: OracleLevel[] = ["L0", "L1", "L2", "L3"];

export function generateScenariosFromGraph(graph: InteractionGraph, oracleLevel: OracleLevel): ScenarioBundle {
  // Validate oracle level
  if (!VALID_ORACLE_LEVELS.includes(oracleLevel)) {
    throw new Error(`잘못된 oracleLevel입니다: ${oracleLevel} (허용: ${VALID_ORACLE_LEVELS.join(", ")})`);
  }

  // Validate graph
  if (!graph || !graph.nodes) {
    throw new Error("빈 interaction graph입니다 (nodes가 없습니다)");
  }

  const routes = graph.nodes.filter((n) => n.kind === "route") as Array<{ kind: "route"; id: string; path: string; methods?: string[]; hasIsland?: boolean; hasSse?: boolean; hasAction?: boolean; isRedirect?: boolean }>;

  if (routes.length === 0) {
    console.warn("[ATE] 경고: route가 없습니다. 빈 시나리오 번들을 생성합니다.");
  }

  const scenarios: GeneratedScenario[] = [];

  for (const r of routes) {
    const isApi = r.path.startsWith("/api/") || (r.methods && r.methods.length > 0);

    // Baseline smoke test for every route
    scenarios.push({
      id: `${isApi ? "api" : "route"}:${r.id}`,
      kind: isApi ? "api-smoke" : "route-smoke",
      route: r.id,
      ...(isApi && r.methods ? { methods: r.methods } : {}),
      oracleLevel,
    });

    if (!isApi) {
      // SSR verification for all page routes
      scenarios.push({
        id: `${r.id}--ssr-verify`,
        kind: "ssr-verify",
        route: r.id,
        hasIsland: !!r.hasIsland,
        ...(r.isRedirect ? { isRedirect: true } : {}),
        oracleLevel,
      });

      // Island hydration for pages with islands.
      // Skip for redirect routes: the origin page navigates away before any
      // island on it could hydrate (issue #224).
      if (r.hasIsland && !r.isRedirect) {
        scenarios.push({
          id: `${r.id}--island-hydration`,
          kind: "island-hydration",
          route: r.id,
          oracleLevel,
        });
      }
    }

    if (isApi) {
      // SSE stream test for API routes with SSE
      if (r.hasSse) {
        scenarios.push({
          id: `${r.id}--sse-stream`,
          kind: "sse-stream",
          route: r.id,
          oracleLevel,
        });
      }

      // Form action test for API routes with POST + _action
      if (r.hasAction) {
        scenarios.push({
          id: `${r.id}--form-action`,
          kind: "form-action",
          route: r.id,
          methods: r.methods,
          oracleLevel,
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    oracleLevel,
    scenarios,
  };
}

export function generateAndWriteScenarios(repoRoot: string, oracleLevel: OracleLevel): { scenariosPath: string; count: number } {
  const paths = getAtePaths(repoRoot);

  let graph: InteractionGraph;
  try {
    graph = readJson<InteractionGraph>(paths.interactionGraphPath);
  } catch (err: unknown) {
    throw new Error(`Interaction graph 읽기 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const bundle = generateScenariosFromGraph(graph, oracleLevel);

  try {
    writeJson(paths.scenariosPath, bundle);
  } catch (err: unknown) {
    throw new Error(`시나리오 파일 저장 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  return { scenariosPath: paths.scenariosPath, count: bundle.scenarios.length };
}

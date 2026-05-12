import type { ObservabilityEvent } from "../../observability/event-bus";
import type { RoutesManifest, RouteSpec } from "../../spec/schema";

export type AgentDevToolsCategory =
  | "hydration"
  | "guard"
  | "contract"
  | "runtime"
  | "release"
  | "agent-tools";

export type AgentDevToolsMode = "observe" | "suggest" | "assist" | "approval_required";

export interface AgentDevToolsError {
  id?: string;
  type?: string;
  severity?: string;
  message: string;
  stack?: string;
  url?: string;
  source?: string;
  line?: number;
  column?: number;
  timestamp?: number;
}

export interface AgentStatsInput {
  totalAgents: number;
  totalEvents: number;
  agents: Record<string, {
    toolCalls: number;
    failures: number;
    topTools: Array<{ tool: string; count: number }>;
    avgDuration: number;
    firstSeen: number;
    lastSeen: number;
  }>;
}

export interface AgentDevToolsRequestLike {
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  timestamp?: number;
  cacheStatus?: string;
}

export interface BuildAgentContextPackInput {
  rootDir: string;
  manifest: RoutesManifest;
  guardEnabled: boolean;
  errors: AgentDevToolsError[];
  requests: AgentDevToolsRequestLike[];
  httpEvents: ObservabilityEvent[];
  mcpEvents: ObservabilityEvent[];
  guardEvents: ObservabilityEvent[];
  agentStats: AgentStatsInput;
}

export interface AgentToolRecommendation {
  task: string;
  skill: string;
  mcpTools: string[];
  cliFallback: string;
  useWhen: string;
}

export interface KnowledgeCard {
  id: string;
  title: string;
  category: AgentDevToolsCategory;
  body: string;
  references: string[];
}

export interface PromptSuggestion {
  title: string;
  copyText: string;
  variables: Array<{ name: string; value: string }>;
}

export interface NextSafeAction {
  mode: AgentDevToolsMode;
  title: string;
  reason: string;
  tool?: string;
  command?: string;
  validation: string[];
  risk: "low" | "medium" | "high";
}

export interface AgentContextPack {
  generatedAt: string;
  project: {
    rootDir: string;
    framework: "mandu";
  };
  summary: {
    routes: {
      total: number;
      pages: number;
      apis: number;
      metadata: number;
      islands: number;
      contracts: number;
    };
    guardEnabled: boolean;
    storedErrors: number;
    recentRequests: number;
    recentHttpErrors: number;
    recentMcpEvents: number;
  };
  agentStatus: {
    totalAgents: number;
    observedToolCalls: number;
    failures: number;
    topTools: Array<{ tool: string; count: number }>;
    brain: {
      oauth: "unknown";
      statusTool: "mandu.brain.status";
      note: string;
    };
  };
  situation: {
    category: AgentDevToolsCategory;
    severity: "info" | "warn" | "error";
    title: string;
    details: string[];
  };
  toolRecommendations: AgentToolRecommendation[];
  knowledgeCards: KnowledgeCard[];
  prompt: PromptSuggestion;
  nextSafeAction: NextSafeAction;
}

const TOOL_ROUTER: Record<AgentDevToolsCategory, AgentToolRecommendation> = {
  hydration: {
    task: "Hydration or client island work",
    skill: "mandu-hydration",
    mcpTools: ["mandu.island.list", "mandu.build.status", "mandu.hydration.set"],
    cliFallback: "bun run build",
    useWhen: "Hydration mismatch, island bundle, client slot, or browser runtime symptoms are present.",
  },
  guard: {
    task: "Architecture boundary work",
    skill: "mandu-guard-guide",
    mcpTools: ["mandu.guard.check", "mandu.guard.explain", "mandu.brain.checkImport"],
    cliFallback: "bun run typecheck",
    useWhen: "Imports, layer boundaries, file placement, or guard violations are relevant.",
  },
  contract: {
    task: "API contract and route schema work",
    skill: "mandu-create-api",
    mcpTools: ["mandu.contract.list", "mandu.contract.validate", "mandu.contract.create"],
    cliFallback: "bun test",
    useWhen: "API routes, request/response schema, generated handlers, or OpenAPI output are involved.",
  },
  runtime: {
    task: "Runtime diagnosis",
    skill: "mandu-debug",
    mcpTools: ["mandu.brain.doctor", "mandu.ai.brief", "mandu.test.smart"],
    cliFallback: "bun test",
    useWhen: "HTTP 4xx/5xx, request correlation, runtime exceptions, or failing tests are visible.",
  },
  release: {
    task: "Release confidence",
    skill: "mandu-release",
    mcpTools: ["mandu.build.status", "mandu.contract.validate", "mandu.test.precommit"],
    cliFallback: "bun run lint && bun run typecheck && bun test",
    useWhen: "The session is clean enough to validate and package changes.",
  },
  "agent-tools": {
    task: "Agent tool selection",
    skill: "mandu-agent-workflow",
    mcpTools: ["mandu.ai.brief", "mandu.brain.status", "mandu.watch.status"],
    cliFallback: "bun run lint",
    useWhen: "The next step is unclear, an agent skipped Mandu tools, or a supervised coding session is starting.",
  },
};

function routeSummary(manifest: RoutesManifest): AgentContextPack["summary"]["routes"] {
  const routes = manifest.routes;
  return {
    total: routes.length,
    pages: routes.filter((route) => route.kind === "page").length,
    apis: routes.filter((route) => route.kind === "api").length,
    metadata: routes.filter((route) => route.kind === "metadata").length,
    islands: routes.filter((route) => !!route.clientModule).length,
    contracts: routes.filter((route) => !!route.contractModule).length,
  };
}

function readStatus(event: ObservabilityEvent | AgentDevToolsRequestLike): number {
  const fromData = "data" in event && typeof event.data?.status === "number"
    ? event.data.status
    : undefined;
  return fromData ?? ("status" in event && typeof event.status === "number" ? event.status : 0);
}

function readPath(event: ObservabilityEvent | AgentDevToolsRequestLike): string {
  if ("data" in event) {
    const path = event.data?.path ?? event.data?.url;
    if (typeof path === "string") return path;
  }
  return "path" in event && typeof event.path === "string" ? event.path : "";
}

function textContains(value: string | undefined, patterns: RegExp[]): boolean {
  if (!value) return false;
  return patterns.some((pattern) => pattern.test(value));
}

function isHydrationError(error: AgentDevToolsError): boolean {
  const patterns = [/hydration/i, /hydrate/i, /island/i, /client slot/i, /data-mandu/i];
  return textContains(error.message, patterns)
    || textContains(error.stack, patterns)
    || textContains(error.source, patterns)
    || textContains(error.type, patterns);
}

function pickSituation(input: BuildAgentContextPackInput): AgentContextPack["situation"] {
  const hydrationError = input.errors.find(isHydrationError);
  if (hydrationError) {
    return {
      category: "hydration",
      severity: "error",
      title: "Hydration issue detected",
      details: [
        hydrationError.message,
        "Start from the island graph and build status before editing UI code.",
      ],
    };
  }

  const failingHttp = [...input.httpEvents, ...input.requests].find((event) => readStatus(event) >= 500);
  if (failingHttp) {
    return {
      category: "runtime",
      severity: "error",
      title: "Recent request failure detected",
      details: [
        `${readStatus(failingHttp)} ${readPath(failingHttp) || "unknown path"}`,
        "Trace the request correlation and reproduce with a targeted test or smoke request.",
      ],
    };
  }

  const guardFailure = input.guardEvents.find((event) => event.severity === "error" || event.severity === "warn");
  if (guardFailure) {
    return {
      category: "guard",
      severity: guardFailure.severity === "error" ? "error" : "warn",
      title: "Architecture guard signal detected",
      details: [
        guardFailure.message,
        "Use the guard toolchain before moving files or changing import paths.",
      ],
    };
  }

  const apiRoutes = input.manifest.routes.filter((route) => route.kind === "api");
  const apiRoutesWithoutContracts = apiRoutes.filter((route) => !route.contractModule);
  if (apiRoutes.length > 0 && apiRoutesWithoutContracts.length > 0) {
    return {
      category: "contract",
      severity: "warn",
      title: "API routes need contract attention",
      details: [
        `${apiRoutesWithoutContracts.length} of ${apiRoutes.length} API routes do not expose a contract module.`,
        "Prefer contract-aware changes so agents can validate request and response shape.",
      ],
    };
  }

  if (input.agentStats.totalEvents === 0) {
    return {
      category: "agent-tools",
      severity: "info",
      title: "No MCP tool usage observed yet",
      details: [
        "Start the session with an AI brief and brain status check.",
        "Record the selected skill, selected MCP tools, fallback reason, changed files, and validation in the agent report.",
      ],
    };
  }

  return {
    category: "release",
    severity: "info",
    title: "Session is ready for confidence checks",
    details: [
      "No high-priority runtime, guard, or hydration signal is currently visible.",
      "Run release confidence checks before shipping broader changes.",
    ],
  };
}

function buildKnowledgeCards(
  input: BuildAgentContextPackInput,
  situation: AgentContextPack["situation"],
): KnowledgeCard[] {
  const summary = routeSummary(input.manifest);
  const cards: KnowledgeCard[] = [
    {
      id: "mcp-first",
      title: "MCP first, CLI second",
      category: "agent-tools",
      body: "Agents should select the Mandu skill and MCP tool for the task domain before falling back to Bun or shell commands.",
      references: ["docs/guides/07_agent_workflow.md", "AGENTS.md"],
    },
    {
      id: "brain-status",
      title: "Brain status is explicit",
      category: "agent-tools",
      body: "Kitchen cannot infer cloud OAuth state from the browser. Ask the MCP layer for mandu.brain.status when LLM-assisted doctor or heal output matters.",
      references: ["packages/mcp/src/tools/brain.ts"],
    },
  ];

  if (summary.islands > 0 || situation.category === "hydration") {
    cards.push({
      id: "hydration-map",
      title: "Inspect islands before editing UI",
      category: "hydration",
      body: "Hydration changes should start from route island inventory and current build status, then narrow to the affected client slot.",
      references: ["packages/mcp/src/tools/hydration.ts", "docs/guides/07_agent_workflow.md"],
    });
  }

  if (input.guardEnabled || situation.category === "guard") {
    cards.push({
      id: "guard-boundaries",
      title: "Guard preserves architecture",
      category: "guard",
      body: "Boundary fixes should explain the violated rule and verify imports with guard tools before typecheck.",
      references: ["packages/mcp/src/tools/guard.ts", "packages/core/src/guard"],
    });
  }

  if (summary.apis > 0 || situation.category === "contract") {
    cards.push({
      id: "contract-confidence",
      title: "Contracts make API edits agent-safe",
      category: "contract",
      body: "API edits should keep route contracts synchronized and use contract validation before broad tests.",
      references: ["packages/mcp/src/tools/contract.ts", "packages/core/src/kitchen/api/contract-api.ts"],
    });
  }

  return cards.slice(0, 6);
}

function buildPrompt(
  situation: AgentContextPack["situation"],
  recommendation: AgentToolRecommendation,
  input: BuildAgentContextPackInput,
): PromptSuggestion {
  const summary = routeSummary(input.manifest);
  const routeHint = pickRouteHint(input.manifest.routes, situation.category);
  const copyText = [
    "You are working inside a Mandu agent-native project.",
    `Task domain: ${situation.category}`,
    `Selected skill: ${recommendation.skill}`,
    `MCP tools to try first: ${recommendation.mcpTools.join(", ")}`,
    `Fallback command only if MCP is unavailable: ${recommendation.cliFallback}`,
    `Current signal: ${situation.title}`,
    `Details: ${situation.details.join(" | ")}`,
    `Route hint: ${routeHint}`,
    `Project shape: ${summary.pages} pages, ${summary.apis} APIs, ${summary.islands} islands, ${summary.contracts} contracts.`,
    "Before editing: inspect affected files and state the exact tool/skill choice.",
    "After editing: report changed files, validation commands, and any fallback reason.",
  ].join("\n");

  return {
    title: `Prompt for ${situation.category} work`,
    copyText,
    variables: [
      { name: "task_domain", value: situation.category },
      { name: "selected_skill", value: recommendation.skill },
      { name: "route_hint", value: routeHint },
    ],
  };
}

function pickRouteHint(routes: RouteSpec[], category: AgentDevToolsCategory): string {
  if (category === "hydration") {
    return routes.find((route) => route.clientModule)?.pattern ?? "No client island route detected.";
  }
  if (category === "contract") {
    return routes.find((route) => route.kind === "api" && !route.contractModule)?.pattern
      ?? routes.find((route) => route.kind === "api")?.pattern
      ?? "No API route detected.";
  }
  return routes[0]?.pattern ?? "No route detected.";
}

function buildNextSafeAction(
  situation: AgentContextPack["situation"],
  recommendation: AgentToolRecommendation,
): NextSafeAction {
  switch (situation.category) {
    case "hydration":
      return {
        mode: "observe",
        title: "Inspect island inventory",
        reason: "Hydration fixes should begin by locating the exact island and build artifact.",
        tool: "mandu.island.list",
        command: "bun run build",
        validation: ["mandu.build.status", "targeted browser smoke if UI changed"],
        risk: "low",
      };
    case "guard":
      return {
        mode: "suggest",
        title: "Run guard check before moving code",
        reason: "Architecture fixes need rule-level evidence before imports are rewritten.",
        tool: "mandu.guard.check",
        command: "bun run typecheck",
        validation: ["mandu.guard.explain for any violation", "bun run typecheck"],
        risk: "low",
      };
    case "contract":
      return {
        mode: "assist",
        title: "Validate route contracts",
        reason: "API edits are safer when request and response shape are checked first.",
        tool: "mandu.contract.validate",
        command: "bun test",
        validation: ["mandu.contract.list", "mandu.contract.validate", "targeted API tests"],
        risk: "medium",
      };
    case "runtime":
      return {
        mode: "suggest",
        title: "Trace failing request",
        reason: "Runtime failures need the exact request path and correlated events before patching.",
        tool: "mandu.brain.doctor",
        command: "bun test",
        validation: ["targeted repro", "related unit or integration test"],
        risk: "medium",
      };
    case "release":
      return {
        mode: "assist",
        title: "Run confidence gate",
        reason: "No blocking signal is visible, so the next useful step is validation.",
        tool: recommendation.mcpTools[0],
        command: recommendation.cliFallback,
        validation: ["lint", "typecheck", "tests"],
        risk: "low",
      };
    case "agent-tools":
      return {
        mode: "observe",
        title: "Check brain and AI brief",
        reason: "The session has not shown MCP usage yet, so establish context before editing.",
        tool: "mandu.ai.brief",
        command: "bun run lint",
        validation: ["mandu.brain.status", "mandu.ai.brief"],
        risk: "low",
      };
  }
}

function flattenTopTools(agentStats: AgentStatsInput): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const agent of Object.values(agentStats.agents)) {
    for (const item of agent.topTools) {
      counts.set(item.tool, (counts.get(item.tool) ?? 0) + item.count);
    }
  }
  return Array.from(counts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function uniqueRecommendations(primary: AgentDevToolsCategory): AgentToolRecommendation[] {
  const order: AgentDevToolsCategory[] = [
    primary,
    "agent-tools",
    "guard",
    "contract",
    "hydration",
    "runtime",
    "release",
  ];
  const seen = new Set<AgentDevToolsCategory>();
  const result: AgentToolRecommendation[] = [];
  for (const category of order) {
    if (seen.has(category)) continue;
    seen.add(category);
    result.push(TOOL_ROUTER[category]);
  }
  return result.slice(0, 4);
}

export function buildAgentContextPack(input: BuildAgentContextPackInput): AgentContextPack {
  const routes = routeSummary(input.manifest);
  const recentHttpErrors = [...input.httpEvents, ...input.requests]
    .filter((event) => readStatus(event) >= 400).length;
  const situation = pickSituation(input);
  const recommendations = uniqueRecommendations(situation.category);
  const primaryRecommendation = recommendations[0] ?? TOOL_ROUTER["agent-tools"];
  const failures = Object.values(input.agentStats.agents)
    .reduce((sum, agent) => sum + agent.failures, 0);

  return {
    generatedAt: new Date().toISOString(),
    project: {
      rootDir: input.rootDir,
      framework: "mandu",
    },
    summary: {
      routes,
      guardEnabled: input.guardEnabled,
      storedErrors: input.errors.length,
      recentRequests: input.requests.length + input.httpEvents.length,
      recentHttpErrors,
      recentMcpEvents: input.mcpEvents.length,
    },
    agentStatus: {
      totalAgents: input.agentStats.totalAgents,
      observedToolCalls: input.agentStats.totalEvents,
      failures,
      topTools: flattenTopTools(input.agentStats),
      brain: {
        oauth: "unknown",
        statusTool: "mandu.brain.status",
        note: "OAuth state is owned by the MCP brain layer; call mandu.brain.status for current provider/tier.",
      },
    },
    situation,
    toolRecommendations: recommendations,
    knowledgeCards: buildKnowledgeCards(input, situation),
    prompt: buildPrompt(situation, primaryRecommendation, input),
    nextSafeAction: buildNextSafeAction(situation, primaryRecommendation),
  };
}

export function handleAgentContextRequest(input: BuildAgentContextPackInput): Response {
  return Response.json(buildAgentContextPack(input));
}

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { buildAgentContextPack, type BuildAgentContextPackInput } from "../../src/kitchen/api/agent-devtools-api";
import { clearKitchenErrors, KitchenHandler, KITCHEN_PREFIX } from "../../src/kitchen/kitchen-handler";
import { eventBus } from "../../src/observability/event-bus";
import type { RoutesManifest } from "../../src/spec/schema";

const pageOnlyManifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "home",
      pattern: "/",
      kind: "page",
      module: "./app/page.tsx",
      componentModule: "./app/page.tsx",
    },
  ],
};

const appManifest: RoutesManifest = {
  version: 1,
  routes: [
    {
      id: "home",
      pattern: "/",
      kind: "page",
      module: "./app/page.tsx",
      componentModule: "./app/page.tsx",
      clientModule: "./app/page.island.tsx",
      hydration: { strategy: "island", priority: "visible", preload: false },
    },
    {
      id: "api-users",
      pattern: "/api/users",
      kind: "api",
      module: "./app/api/users/route.ts",
      methods: ["GET"],
    },
  ],
};

function resetBus() {
  for (let i = 0; i < 250; i++) {
    eventBus.emit({
      type: "cache",
      severity: "info",
      source: "reset",
      message: "reset",
    });
  }
}

function createInput(overrides: Partial<BuildAgentContextPackInput> = {}): BuildAgentContextPackInput {
  return {
    rootDir: "C:/tmp/mandu-app",
    manifest: pageOnlyManifest,
    guardEnabled: false,
    errors: [],
    requests: [],
    httpEvents: [],
    mcpEvents: [],
    guardEvents: [],
    agentStats: {
      agents: {},
      totalAgents: 0,
      totalEvents: 0,
    },
    ...overrides,
  };
}

describe("buildAgentContextPack", () => {
  it("starts a quiet session with agent tool guidance", () => {
    const pack = buildAgentContextPack(createInput());

    expect(pack.situation.category).toBe("agent-tools");
    expect(pack.nextSafeAction.tool).toBe("mandu.ai.brief");
    expect(pack.toolRecommendations[0].skill).toBe("mandu-agent-workflow");
    expect(pack.prompt.copyText).toContain("MCP tools to try first");
  });

  it("prioritizes hydration when a hydration error is stored", () => {
    const pack = buildAgentContextPack(createInput({
      manifest: appManifest,
      errors: [
        {
          id: "e1",
          type: "runtime",
          severity: "error",
          message: "Hydration failed because the initial UI does not match the server HTML.",
          source: "./app/page.island.tsx",
        },
      ],
    }));

    expect(pack.situation.category).toBe("hydration");
    expect(pack.toolRecommendations[0].skill).toBe("mandu-hydration");
    expect(pack.toolRecommendations[0].mcpTools).toContain("mandu.island.list");
    expect(pack.nextSafeAction.tool).toBe("mandu.island.list");
    expect(pack.prompt.copyText).toContain("Selected skill: mandu-hydration");
  });

  it("classifies a hydrated project with empty bundle manifest as build-broken (plan 18 P0-2)", () => {
    const pack = buildAgentContextPack(createInput({
      manifest: appManifest,
      bundleManifest: {
        version: 1,
        buildTime: "2026-05-12T00:00:00.000Z",
        env: "development",
        bundles: {},
        shared: { runtime: "/.mandu/client/runtime.js", vendor: "/.mandu/client/vendor.js" },
      },
    }));

    expect(pack.situation.category).toBe("build-broken");
    expect(pack.situation.severity).toBe("warn");
    expect(pack.toolRecommendations[0].mcpTools).toContain("mandu.build.status");
    expect(pack.nextSafeAction.tool).toBe("mandu.build");
    expect(pack.summary.bundle?.bundleCount).toBe(0);
    expect(pack.summary.bundle?.islandCount).toBe(0);
    expect(pack.prompt.copyText).toContain("Build state:");
  });

  it("classifies manifest_freshness diagnose error as build-broken", () => {
    const pack = buildAgentContextPack(createInput({
      manifest: appManifest,
      diagnoseReport: {
        healthy: false,
        errorCount: 1,
        warningCount: 0,
        summary: { total: 1, passed: 0, failed: 1 },
        checks: [
          {
            ok: false,
            rule: "manifest_freshness",
            severity: "error",
            message: "Bundle manifest .mandu/manifest.json is missing.",
            suggestion: "Run `mandu build`.",
          },
        ],
      },
    }));

    expect(pack.situation.category).toBe("build-broken");
    expect(pack.situation.severity).toBe("error");
    expect(pack.prompt.copyText).toContain("Diagnose:");
    expect(pack.prompt.copyText).toContain("manifest_freshness");
  });

  it("classifies nested_internal_core diagnose error as boot-breaking (#261)", () => {
    const pack = buildAgentContextPack(createInput({
      manifest: pageOnlyManifest,
      diagnoseReport: {
        healthy: false,
        errorCount: 1,
        warningCount: 0,
        summary: { total: 1, passed: 0, failed: 1 },
        checks: [
          {
            ok: false,
            rule: "nested_internal_core",
            severity: "error",
            message: "1 stale nested @mandujs/core install(s) shadow the hoisted 0.53.3.",
            suggestion: "Run `rm -rf node_modules/@mandujs/mcp/node_modules`.",
          },
        ],
      },
    }));

    expect(pack.situation.category).toBe("boot-breaking");
    expect(pack.situation.severity).toBe("error");
    expect(pack.toolRecommendations[0].mcpTools).toContain("mandu.diagnose");
    expect(pack.nextSafeAction.tool).toBe("mandu.diagnose");
    expect(pack.summary.diagnose?.failedRules).toContain("nested_internal_core");
  });

  it("boot-breaking takes priority over hydration error", () => {
    const pack = buildAgentContextPack(createInput({
      manifest: appManifest,
      errors: [
        {
          message: "Hydration failed",
          source: "./app/page.island.tsx",
        },
      ],
      diagnoseReport: {
        healthy: false,
        errorCount: 1,
        warningCount: 0,
        summary: { total: 1, passed: 0, failed: 1 },
        checks: [
          {
            ok: false,
            rule: "package_export_gaps",
            severity: "error",
            message: "1 @mandujs/core subpath(s) imported but not in exports map.",
          },
        ],
      },
    }));

    expect(pack.situation.category).toBe("boot-breaking");
  });

  it("includes changed files in the prompt when supplied", () => {
    const pack = buildAgentContextPack(createInput({
      manifest: pageOnlyManifest,
      changedFiles: [
        "app/page.tsx",
        "app/api/users/route.ts",
        "spec/contracts/users.ts",
      ],
    }));

    expect(pack.summary.changedFiles?.count).toBe(3);
    expect(pack.summary.changedFiles?.sample).toContain("app/page.tsx");
    expect(pack.prompt.copyText).toContain("Changed files (3");
  });

  it("uses contract guidance when API routes do not expose contracts", () => {
    const pack = buildAgentContextPack(createInput({
      manifest: appManifest,
      agentStats: {
        agents: {
          agent1: {
            toolCalls: 1,
            failures: 0,
            topTools: [{ tool: "mandu.ai.brief", count: 1 }],
            avgDuration: 12,
            firstSeen: 1,
            lastSeen: 2,
          },
        },
        totalAgents: 1,
        totalEvents: 1,
      },
    }));

    expect(pack.situation.category).toBe("contract");
    expect(pack.toolRecommendations[0].skill).toBe("mandu-create-api");
    expect(pack.nextSafeAction.tool).toBe("mandu.contract.validate");
  });
});

describe("KitchenHandler /api/errors/grouped endpoint (plan 18 P1-4)", () => {
  let tmpDir: string;
  let handler: KitchenHandler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-errors-grouped-"));
    clearKitchenErrors();
    handler = new KitchenHandler({
      rootDir: tmpDir,
      manifest: pageOnlyManifest,
      guardConfig: null,
    });
  });

  afterEach(() => {
    handler.stop();
    clearKitchenErrors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function postError(payload: Record<string, unknown>): Promise<void> {
    const post = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await handler.handle(post, `${KITCHEN_PREFIX}/api/errors`);
  }

  it("collapses three identical hydration errors into one group with count=3", async () => {
    for (let i = 0; i < 3; i++) {
      await postError({
        type: "runtime",
        severity: "error",
        message: "Hydration failed while rendering the cart island.",
        source: "./app/page.island.tsx",
      });
    }

    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/errors/grouped`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/errors/grouped`);
    const body = await res!.json() as {
      groups: Array<{ count: number; sample: { message: string } }>;
      groupCount: number;
      totalCount: number;
    };

    expect(body.totalCount).toBe(3);
    expect(body.groupCount).toBe(1);
    expect(body.groups[0].count).toBe(3);
    expect(body.groups[0].sample.message).toMatch(/Hydration failed/);
  });

  it("keeps distinct messages in separate groups", async () => {
    await postError({ type: "runtime", severity: "error", message: "Hydration failed.", source: "./a.tsx" });
    await postError({ type: "runtime", severity: "error", message: "Network refused.", source: "./b.tsx" });

    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/errors/grouped`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/errors/grouped`);
    const body = await res!.json() as { groupCount: number; totalCount: number };

    expect(body.totalCount).toBe(2);
    expect(body.groupCount).toBe(2);
  });
});

describe("KitchenHandler /api/events endpoint (plan 18 P1-3)", () => {
  let tmpDir: string;
  let handler: KitchenHandler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-events-"));
    resetBus();
    handler = new KitchenHandler({
      rootDir: tmpDir,
      manifest: pageOnlyManifest,
      guardConfig: null,
    });
  });

  afterEach(() => {
    handler.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns all event types when no filter is supplied", async () => {
    eventBus.emit({ type: "build", severity: "info", source: "test", message: "build ok" });
    eventBus.emit({ type: "cache", severity: "info", source: "test", message: "cache hit" });
    eventBus.emit({ type: "ws", severity: "info", source: "test", message: "ws open" });

    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/events`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/events`);
    const body = await res!.json() as { events: Array<{ type: string }> };

    const types = body.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["build", "cache", "ws"]));
  });

  it("filters by ?type=build (previously invisible category)", async () => {
    eventBus.emit({ type: "build", severity: "info", source: "test", message: "rebuild 1" });
    eventBus.emit({ type: "build", severity: "info", source: "test", message: "rebuild 2" });
    eventBus.emit({ type: "http", severity: "info", source: "test", message: "GET /" });

    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/events?type=build`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/events`);
    const body = await res!.json() as { events: Array<{ type: string; message: string }> };

    expect(body.events.length).toBe(2);
    expect(body.events.every((e) => e.type === "build")).toBe(true);
  });

  it("rejects unknown type values (no filter applied)", async () => {
    eventBus.emit({ type: "build", severity: "info", source: "test", message: "build" });
    eventBus.emit({ type: "http", severity: "info", source: "test", message: "http" });

    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/events?type=badtype`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/events`);
    const body = await res!.json() as { events: Array<{ type: string }> };

    // Unknown type is silently dropped → all events returned
    const types = body.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["build", "http"]));
  });

  it("?stats=1 returns per-type counters covering all 8 categories", async () => {
    eventBus.emit({ type: "ate", severity: "info", source: "test", message: "spec done" });
    eventBus.emit({ type: "ate", severity: "error", source: "test", message: "spec failed" });

    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/events?stats=1`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/events`);
    const body = await res!.json() as {
      stats: Record<string, { count: number; errors: number; avgDuration: number }>;
    };

    expect(body.stats.ate.count).toBe(2);
    expect(body.stats.ate.errors).toBe(1);
    // All 8 categories should always be present so the UI can render
    // a stable per-chip stat row.
    expect(Object.keys(body.stats)).toEqual(
      expect.arrayContaining(["http", "mcp", "guard", "build", "error", "cache", "ws", "ate"]),
    );
  });
});

describe("KitchenHandler /api/agent-context endpoint", () => {
  let tmpDir: string;
  let handler: KitchenHandler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-agent-context-"));
    fs.mkdirSync(path.join(tmpDir, ".mandu"), { recursive: true });
    clearKitchenErrors();
    resetBus();
    handler = new KitchenHandler({
      rootDir: tmpDir,
      manifest: appManifest,
      guardConfig: null,
    });
  });

  afterEach(() => {
    handler.stop();
    clearKitchenErrors();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a context pack from current Kitchen state", async () => {
    const req = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/agent-context`);
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/agent-context`);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = await res!.json() as {
      summary: { routes: { total: number; islands: number; apis: number } };
      agentStatus: { brain: { statusTool: string } };
      knowledgeCards: Array<{ id: string }>;
    };
    expect(body.summary.routes.total).toBe(2);
    expect(body.summary.routes.islands).toBe(1);
    expect(body.summary.routes.apis).toBe(1);
    expect(body.agentStatus.brain.statusTool).toBe("mandu.brain.status");
    expect(body.knowledgeCards.some((card) => card.id === "mcp-first")).toBe(true);
  });

  it("reflects stored browser errors in the context pack", async () => {
    const post = new Request(`http://localhost:3000${KITCHEN_PREFIX}/api/errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "runtime",
        severity: "error",
        message: "Hydration failed while rendering the cart island.",
        source: "./app/page.island.tsx",
      }),
    });
    const postRes = await handler.handle(post, `${KITCHEN_PREFIX}/api/errors`);
    expect(postRes!.status).toBe(200);

    // Plan 18 P0-2 — bundle/diagnose/diff signals would otherwise flag
    // this fixture as build-broken (no .mandu/manifest.json in tmpDir).
    // This test isolates the hydration-error classification path, so we
    // opt out of those signals via query params.
    const req = new Request(
      `http://localhost:3000${KITCHEN_PREFIX}/api/agent-context?bundle=0&diagnose=0&diff=0`,
    );
    const res = await handler.handle(req, `${KITCHEN_PREFIX}/api/agent-context`);
    const body = await res!.json() as {
      situation: { category: string };
      summary: { storedErrors: number };
      nextSafeAction: { tool?: string };
    };

    expect(body.summary.storedErrors).toBe(1);
    expect(body.situation.category).toBe("hydration");
    expect(body.nextSafeAction.tool).toBe("mandu.island.list");
  });
});

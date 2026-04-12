/**
 * Mandu MCP - Composite Tools
 * Multi-step workflow tools combining existing handlers into single-call operations.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getProjectPaths } from "../utils/project.js";
import { specTools } from "./spec.js";
import { guardTools } from "./guard.js";
import { contractTools } from "./contract.js";
import { generateTools } from "./generate.js";
import { kitchenTools } from "./kitchen.js";
import path from "path";
import fs from "fs/promises";

export const compositeToolDefinitions: Tool[] = [
  {
    name: "mandu.feature.create",
    description:
      "Create a complete feature: route + contract + slot + island scaffold in one call. " +
      "Sequentially runs: negotiate -> add_route -> create_contract -> generate -> guard_check.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Feature name (English kebab-case)" },
        description: { type: "string", description: "Feature description" },
        kind: { type: "string", enum: ["page", "api", "both"], description: "Route kind (default: both)" },
        methods: { type: "array", items: { type: "string" }, description: "HTTP methods (default: ['GET', 'POST'])" },
        withContract: { type: "boolean", description: "Create Zod contract file (default: true)" },
        withIsland: { type: "boolean", description: "Create island component (default: false)" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "mandu.diagnose",
    description:
      "Run all diagnostic checks in parallel and return a unified health report. " +
      "Combines: kitchen_errors + guard_check + validate_contracts + validate_manifest.",
    inputSchema: {
      type: "object",
      properties: {
        autoFix: { type: "boolean", description: "Attempt automatic fixes for guard violations (default: false)" },
      },
    },
  },
  {
    name: "mandu.island.add",
    description:
      "Create an island component with correct @mandujs/core/client imports and hydration strategy. " +
      "Generates a .island.tsx file in app/{route}/ with the island() wrapper.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Island component name (PascalCase)" },
        route: { type: "string", description: "Route path to attach to (e.g. 'blog/[slug]')" },
        strategy: { type: "string", enum: ["load", "idle", "visible", "media", "never"], description: "Hydration strategy (default: visible)" },
      },
      required: ["name", "route"],
    },
  },
];

export function compositeTools(projectRoot: string) {
  const paths = getProjectPaths(projectRoot);
  const spec = specTools(projectRoot);
  const guard = guardTools(projectRoot);
  const contract = contractTools(projectRoot);
  const generate = generateTools(projectRoot);
  const kitchen = kitchenTools(projectRoot);

  return {
    "mandu.feature.create": async (args: Record<string, unknown>) => {
      const { name, description, kind = "both", methods = ["GET", "POST"],
        withContract = true, withIsland = false,
      } = args as {
        name: string; description: string; kind?: "page" | "api" | "both";
        methods?: string[]; withContract?: boolean; withIsland?: boolean;
      };
      const steps: { step: string; result: unknown }[] = [];
      const kinds: Array<"page" | "api"> = kind === "both" ? ["api", "page"] : [kind];

      // Step 1: negotiate architecture
      steps.push({ step: "negotiate", result: await guard.mandu_negotiate({ intent: description, featureName: name }) });

      // Step 2-3: add routes + contracts
      for (const k of kinds) {
        const routePath = k === "api" ? `api/${name}` : name;
        steps.push({ step: `add_route(${k})`, result: await spec.mandu_add_route({ path: routePath, kind: k, withSlot: true, withContract: false }) });
        if (withContract && k === "api") {
          const routeId = routePath.replace(/\//g, "-").replace(/[\[\]\.]/g, "");
          steps.push({ step: "create_contract", result: await contract.mandu_create_contract({ routeId, description, methods }) });
        }
      }

      // Step 4-5: generate + guard
      steps.push({ step: "generate", result: await generate.mandu_generate({ dryRun: false }) });
      steps.push({ step: "guard_check", result: await guard.mandu_guard_check({ autoCorrect: false }) });

      // Step 6 (optional): create island
      if (withIsland && kinds.includes("page")) {
        const pc = toPascalCase(name);
        const islandFile = path.join(paths.appDir, name, `${pc}.island.tsx`);
        await fs.mkdir(path.dirname(islandFile), { recursive: true });
        await Bun.write(islandFile, generateIslandSource(pc, "visible"));
        steps.push({ step: "create_island", result: { file: `app/${name}/${pc}.island.tsx` } });
      }

      return { success: true, feature: name, description, steps,
        summary: { routesCreated: kinds.length, contractCreated: withContract, islandCreated: withIsland && kinds.includes("page") } };
    },

    "mandu.diagnose": async (args: Record<string, unknown>) => {
      const { autoFix = false } = args as { autoFix?: boolean };
      const [kitchenResult, guardResult, contractResult, manifestResult] = await Promise.all([
        kitchen.mandu_kitchen_errors({ clear: false }).catch((e: Error) => ({ error: e.message })),
        guard.mandu_guard_check({ autoCorrect: autoFix }).catch((e: Error) => ({ error: e.message })),
        contract.mandu_validate_contracts().catch((e: Error) => ({ error: e.message })),
        spec.mandu_validate_manifest().catch((e: Error) => ({ error: e.message })),
      ]);
      const checks = [
        { name: "kitchen_errors", result: kitchenResult },
        { name: "guard_check", result: guardResult },
        { name: "contract_validation", result: contractResult },
        { name: "manifest_validation", result: manifestResult },
      ];
      const isFail = (c: typeof checks[number]) => {
        const r = c.result as Record<string, unknown>;
        return r.error || r.passed === false || r.valid === false;
      };
      return {
        healthy: !checks.some(isFail), autoFix, checks,
        summary: { total: checks.length, passed: checks.filter((c) => !isFail(c)).length, failed: checks.filter(isFail).length },
      };
    },

    "mandu.island.add": async (args: Record<string, unknown>) => {
      const { name, route, strategy = "visible" } = args as {
        name: string; route: string; strategy?: "load" | "idle" | "visible" | "media" | "never";
      };
      const islandFileName = `${name}.island.tsx`;
      const islandRelPath = `app/${route}/${islandFileName}`;
      const islandFullPath = path.join(paths.appDir, route, islandFileName);

      try { await fs.access(islandFullPath); return { success: false, error: `Island file already exists: ${islandRelPath}` }; } catch { /* proceed */ }

      await fs.mkdir(path.dirname(islandFullPath), { recursive: true });
      await Bun.write(islandFullPath, generateIslandSource(name, strategy));
      return {
        success: true, file: islandRelPath, component: name, strategy,
        nextSteps: [`Import <${name} /> in app/${route}/page.tsx`, "Run mandu_build to compile the client bundle", `Island hydrates on '${strategy}'`],
      };
    },
  };
}

function toPascalCase(kebab: string): string {
  return kebab.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

function generateIslandSource(name: string, strategy: string): string {
  return `"use client";
import { island } from "@mandujs/core/client";
import { useState } from "react";

interface ${name}Props {
  [key: string]: unknown;
}

function ${name}Inner(props: ${name}Props) {
  const [count, setCount] = useState(0);
  return (
    <div data-island="${name}">
      <p>Island: ${name}</p>
      <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>
    </div>
  );
}

export default island("${strategy}", ${name}Inner);
`;
}

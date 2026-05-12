/**
 * Mandu MCP Kitchen Tools
 * Bridge between Kitchen DevTools (browser) and MCP protocol.
 * Enables any MCP-compatible agent to read client-side errors in real-time.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadManduConfig } from "@mandujs/core";
import { getDevServerState } from "./project.js";

export const kitchenToolDefinitions: Tool[] = [
  {
    name: "mandu.kitchen.errors",
    description:
      "Read client-side errors captured by Kitchen DevTools. Use clear=true to clear after reading.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        clear: {
          type: "boolean",
          description: "Clear errors after reading (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "mandu.devtools.context",
    description:
      "Read the Kitchen Agent Supervisor context pack — one call returns the current situation, recommended skill/MCP tools, knowledge cards, a copyable prompt, and the next safe action. Combines routes, recent errors, HTTP traffic, MCP usage, bundle manifest, diagnose report, and changed files. Use this at session start or whenever you are unsure what to work on next. Requires `mandu dev` to be running.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        includeBundle: {
          type: "boolean",
          description:
            "Include bundle manifest summary (.mandu/manifest.json). Default true. Set false to skip on very large projects.",
        },
        includeDiagnose: {
          type: "boolean",
          description:
            "Include the extended diagnose report. Default true. Set false to lower latency when a11y_hints / package_export_gaps are noisy.",
        },
        includeDiff: {
          type: "boolean",
          description:
            "Include git diff against MANDU_DIFF_BASE (default HEAD). Default true. Set false to skip when git is unavailable.",
        },
      },
      required: [],
    },
  },
];

/**
 * Resolve the dev server base URL. Prefers the port parsed from the
 * currently running `mandu dev` stdout; falls back to mandu config; final
 * default is 3333. Shared by every Kitchen-backed MCP tool so they all
 * agree on where to fetch from.
 */
async function resolveDevServerBaseUrl(projectRoot: string): Promise<string> {
  let port: number | undefined;

  const serverState = getDevServerState();
  if (serverState) {
    for (const line of serverState.output) {
      const portMatch = line.match(/https?:\/\/localhost:(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }
    }
  }

  if (!port) {
    const config = await loadManduConfig(projectRoot);
    port = config.server?.port ?? 3333;
  }

  return `http://localhost:${port}`;
}

export function kitchenTools(projectRoot: string) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    "mandu.kitchen.errors": async (args: Record<string, unknown>) => {
      const { clear = false } = args as { clear?: boolean };
      const baseUrl = await resolveDevServerBaseUrl(projectRoot);

      try {
        // Fetch errors from Kitchen API
        const res = await fetch(`${baseUrl}/__kitchen/api/errors`);
        if (!res.ok) {
          return {
            success: false,
            message: `Dev server not reachable at ${baseUrl}. Is 'mandu dev' running?`,
            errors: [],
          };
        }

        const data = await res.json() as { errors: unknown[]; count: number };

        // Clear if requested
        if (clear && data.count > 0) {
          await fetch(`${baseUrl}/__kitchen/api/errors`, { method: "DELETE" });
        }

        if (data.count === 0) {
          return {
            success: true,
            message: "No client-side errors detected.",
            errors: [],
            count: 0,
          };
        }

        return {
          success: true,
          message: `${data.count} client-side error(s) captured.${clear ? " Errors cleared." : ""}`,
          errors: data.errors,
          count: data.count,
          relatedSkills: ["mandu-debug"],
        };
      } catch {
        return {
          success: false,
          message: `Cannot connect to dev server at ${baseUrl}. Make sure 'mandu dev' is running.`,
          errors: [],
        };
      }
    },

    /**
     * Plan 18 P0-1 — read-only Agent Supervisor context pack.
     *
     * Fetches `/__kitchen/api/agent-context` and returns the full pack
     * so an agent can self-orient with a single call: current situation,
     * top tool recommendation, knowledge cards, copyable prompt, and the
     * next safe action. Three optional toggles let the caller skip
     * expensive signals when latency matters.
     */
    "mandu.devtools.context": async (args: Record<string, unknown>) => {
      const {
        includeBundle = true,
        includeDiagnose = true,
        includeDiff = true,
      } = args as { includeBundle?: boolean; includeDiagnose?: boolean; includeDiff?: boolean };

      const baseUrl = await resolveDevServerBaseUrl(projectRoot);
      const params = new URLSearchParams();
      if (!includeBundle) params.set("bundle", "0");
      if (!includeDiagnose) params.set("diagnose", "0");
      if (!includeDiff) params.set("diff", "0");
      const query = params.toString();
      const url = `${baseUrl}/__kitchen/api/agent-context${query ? `?${query}` : ""}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          return {
            success: false,
            message: `Dev server not reachable at ${baseUrl}. Is 'mandu dev' running?`,
            status: res.status,
          };
        }

        const pack = await res.json() as Record<string, unknown>;
        return {
          success: true,
          message: "Agent Supervisor context pack retrieved.",
          pack,
          relatedSkills: ["mandu-agent-workflow", "mandu-debug"],
        };
      } catch {
        return {
          success: false,
          message: `Cannot connect to dev server at ${baseUrl}. Make sure 'mandu dev' is running.`,
        };
      }
    },
  };

  // Backward-compatible aliases (underscore form for legacy MCP clients
  // that don't accept dots in tool names).
  handlers["mandu_kitchen_errors"] = handlers["mandu.kitchen.errors"];
  handlers["mandu_devtools_context"] = handlers["mandu.devtools.context"];

  return handlers;
}

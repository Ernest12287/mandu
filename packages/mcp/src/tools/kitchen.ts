/**
 * Mandu MCP Kitchen Tools
 * Bridge between Kitchen DevTools (browser) and MCP protocol.
 * Enables any MCP-compatible agent to read client-side errors in real-time.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadManduConfig } from "@mandujs/core";

export const kitchenToolDefinitions: Tool[] = [
  {
    name: "mandu_kitchen_errors",
    description:
      "Read client-side errors captured by the Mandu Kitchen DevTools in the browser. " +
      "Errors are automatically reported from the browser to the dev server when they occur " +
      "(runtime exceptions, unhandled promise rejections, React errors, network failures). " +
      "Use this tool to diagnose client-side issues without asking the user to copy-paste error messages. " +
      "Returns the error list with stack traces, source locations, and timestamps. " +
      "Call with clear=true to acknowledge and clear processed errors.",
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
];

export function kitchenTools(projectRoot: string) {
  return {
    mandu_kitchen_errors: async (args: Record<string, unknown>) => {
      const { clear = false } = args as { clear?: boolean };

      // Read port from mandu config
      const config = await loadManduConfig(projectRoot);
      const port = config.server?.port ?? 4567;
      const baseUrl = `http://localhost:${port}`;

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
        };
      } catch {
        return {
          success: false,
          message: `Cannot connect to dev server at ${baseUrl}. Make sure 'mandu dev' is running.`,
          errors: [],
        };
      }
    },
  };
}

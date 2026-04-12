/**
 * MCP Resources for Mandu Framework
 *
 * Project state data exposed via the MCP resource protocol.
 */

import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import path from "path";
import { readConfig, readJsonFile } from "./utils/project.js";
import { loadManduConfig, loadManifest } from "@mandujs/core";
import { getDevServerState } from "./tools/project.js";

export const manduResourceDefinitions: Resource[] = [
  {
    uri: "mandu://routes",
    name: "Route Manifest",
    description: "Current project route manifest (JSON)",
    mimeType: "application/json",
  },
  {
    uri: "mandu://config",
    name: "Mandu Config",
    description: "Parsed mandu.config.ts settings",
    mimeType: "application/json",
  },
  {
    uri: "mandu://errors",
    name: "Recent Errors",
    description: "Recent build and runtime errors",
    mimeType: "application/json",
  },
];

type ResourceReadResult = { uri: string; mimeType: string; text: string };
type ResourceHandler = () => Promise<ResourceReadResult>;

function jsonResult(uri: string, data: unknown): ResourceReadResult {
  return { uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) };
}

export function manduResourceHandlers(projectRoot: string): Record<string, ResourceHandler> {
  const manifestPath = path.join(projectRoot, ".mandu", "routes.manifest.json");

  return {
    "mandu://routes": async () => {
      const result = await loadManifest(manifestPath);
      if (!result.success || !result.data) {
        return jsonResult("mandu://routes", {
          error: "Failed to load route manifest",
          details: result.errors,
          hint: "Run 'mandu generate' or 'mandu dev' to create the manifest.",
        });
      }
      return jsonResult("mandu://routes", {
        version: result.data.version,
        routeCount: result.data.routes.length,
        routes: result.data.routes.map((r) => ({
          id: r.id, pattern: r.pattern, kind: r.kind, module: r.module,
          slotModule: r.slotModule ?? null, clientModule: r.clientModule ?? null,
        })),
      });
    },

    "mandu://config": async () => {
      try {
        const config = await loadManduConfig(projectRoot);
        return jsonResult("mandu://config", {
          server: config.server ?? {},
          guard: config.guard ?? {},
          build: config.build ?? {},
          dev: config.dev ?? {},
          fsRoutes: config.fsRoutes ?? {},
          seo: config.seo ?? {},
        });
      } catch {
        const raw = await readConfig(projectRoot);
        return jsonResult("mandu://config", raw ?? {
          error: "No mandu.config.ts/js/json found",
          hint: "Create a mandu.config.ts in the project root.",
        });
      }
    },

    "mandu://errors": async () => {
      const errors: unknown[] = [];

      // Try Kitchen DevTools error log from running dev server
      let port: number | undefined;
      const serverState = getDevServerState();
      if (serverState) {
        for (const line of serverState.output) {
          const m = line.match(/https?:\/\/localhost:(\d+)/);
          if (m) port = parseInt(m[1], 10);
        }
      }
      if (port) {
        try {
          const res = await fetch(`http://localhost:${port}/__kitchen/api/errors`);
          if (res.ok) {
            const body = (await res.json()) as { errors: unknown[] };
            if (body.errors?.length) errors.push(...body.errors);
          }
        } catch { /* dev server not reachable */ }
      }

      // Read local error log file
      const loggedErrors = await readJsonFile<unknown[]>(
        path.join(projectRoot, ".mandu", "errors.json"),
      );
      if (Array.isArray(loggedErrors)) errors.push(...loggedErrors);

      return jsonResult("mandu://errors", {
        count: errors.length,
        errors,
        source: port ? "kitchen+log" : "log",
      });
    },
  };
}

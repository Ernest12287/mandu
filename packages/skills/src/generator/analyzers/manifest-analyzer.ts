/**
 * Manifest analyzer — reads `.mandu/manifest.json` + `shared/resources/` to
 * produce a concise, skill-template-ready picture of the project's API
 * surface.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ManifestAnalysis } from "../types";

export function analyzeManifest(repoRoot: string): ManifestAnalysis {
  const result: ManifestAnalysis = {
    present: false,
    totalRoutes: 0,
    apiRoutes: 0,
    pageRoutes: 0,
    resources: [],
    sampleRoutes: [],
  };

  const manifestPath = join(repoRoot, ".mandu", "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && "routes" in parsed) {
        const routes = (parsed as { routes?: unknown }).routes;
        if (Array.isArray(routes)) {
          result.present = true;
          result.totalRoutes = routes.length;

          for (const r of routes) {
            if (!r || typeof r !== "object") continue;
            const route = r as Record<string, unknown>;
            const kind = typeof route.kind === "string" ? route.kind : undefined;
            if (kind === "api") result.apiRoutes++;
            else if (kind === "page") result.pageRoutes++;
          }

          result.sampleRoutes = routes
            .slice(0, 10)
            .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
            .map((r) => ({
              id: String(r.id ?? ""),
              pattern: typeof r.pattern === "string" ? r.pattern : undefined,
              kind: typeof r.kind === "string" ? r.kind : undefined,
              methods: Array.isArray(r.methods)
                ? (r.methods as unknown[]).filter((m): m is string => typeof m === "string")
                : undefined,
            }))
            .filter((r) => r.id);
        }
      }
    } catch {
      // Malformed manifest — treat as absent
    }
  }

  const resourcesDir = join(repoRoot, "shared", "resources");
  if (existsSync(resourcesDir)) {
    try {
      const entries = readdirSync(resourcesDir);
      for (const entry of entries) {
        if (!entry.endsWith(".resource.ts") && !entry.endsWith(".resource.tsx")) continue;
        const full = join(resourcesDir, entry);
        try {
          if (!statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        result.resources.push(entry.replace(/\.resource\.(ts|tsx)$/, ""));
      }
    } catch {
      // ignore
    }
  }

  return result;
}

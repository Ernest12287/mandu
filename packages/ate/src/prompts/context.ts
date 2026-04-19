/**
 * ATE Prompt Library — Project Context Loader
 *
 * Collects project-level facts (manifest, resources, guard preset, system
 * docs) into a single `PromptContext` object without pulling LLM deps. Safe
 * to call in any environment — all file reads are defensive.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PromptContext } from "./types";

export interface LoadContextOptions {
  repoRoot: string;
  /** Include a parsed `.mandu/manifest.json` if present. */
  includeManifest?: boolean;
  /** Include `docs/prompts/*.md` as systemDocs. */
  includePromptDocs?: boolean;
  /** Additional extra docs (name → absolute path). */
  extraDocs?: Array<{ name: string; path: string }>;
  /** Cap doc content per-file (chars) to avoid huge token spend. */
  maxDocChars?: number;
}

/**
 * Load a best-effort project context. Missing files are silently skipped —
 * callers that need hard guarantees should inspect the returned object.
 */
export function loadProjectContext(options: LoadContextOptions): PromptContext {
  const {
    repoRoot,
    includeManifest = true,
    includePromptDocs = true,
    extraDocs = [],
    maxDocChars = 4000,
  } = options;

  const ctx: PromptContext = { repoRoot };

  if (includeManifest) {
    const manifestPath = join(repoRoot, ".mandu", "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && "routes" in parsed) {
          const routes = (parsed as { routes?: unknown }).routes;
          if (Array.isArray(routes)) {
            ctx.manifest = {
              version: (parsed as { version?: number }).version,
              routes: routes
                .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
                .map((r) => ({
                  id: String(r.id ?? ""),
                  pattern: typeof r.pattern === "string" ? r.pattern : undefined,
                  kind: typeof r.kind === "string" ? r.kind : undefined,
                  methods: Array.isArray(r.methods)
                    ? (r.methods as unknown[]).filter((m): m is string => typeof m === "string")
                    : undefined,
                  file: typeof r.module === "string" ? r.module : undefined,
                })),
            };
          }
        }
      } catch {
        /* swallow — missing / malformed manifest is non-fatal for prompts */
      }
    }
  }

  // Resource definitions — scan shared/resources for *.resource.ts (lightweight)
  const resourcesDir = join(repoRoot, "shared", "resources");
  if (existsSync(resourcesDir)) {
    try {
      const files = readdirSync(resourcesDir).filter(
        (f) => f.endsWith(".resource.ts") || f.endsWith(".resource.tsx"),
      );
      const names = files.map((f) => f.replace(/\.resource\.(ts|tsx)$/, ""));
      if (names.length > 0) {
        ctx.resources = names.map((name) => ({ name }));
      }
    } catch {
      /* ignore */
    }
  }

  // Guard preset — look for a preset hint in guard.config.ts / mandu.config.ts
  const presetFromConfig = detectGuardPreset(repoRoot);
  if (presetFromConfig) {
    ctx.guardPreset = presetFromConfig;
  }

  const docs: Array<{ name: string; content: string }> = [];

  if (includePromptDocs) {
    const docsDir = join(repoRoot, "docs", "prompts");
    if (existsSync(docsDir)) {
      try {
        const entries = readdirSync(docsDir);
        for (const entry of entries) {
          if (!entry.endsWith(".md")) continue;
          const full = join(docsDir, entry);
          try {
            if (statSync(full).isFile()) {
              let content = readFileSync(full, "utf8");
              if (content.length > maxDocChars) {
                content = content.slice(0, maxDocChars) + "\n\n<!-- truncated -->";
              }
              docs.push({ name: entry.replace(/\.md$/, ""), content });
            }
          } catch {
            /* ignore per-file */
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  for (const extra of extraDocs) {
    if (!existsSync(extra.path)) continue;
    try {
      let content = readFileSync(extra.path, "utf8");
      if (content.length > maxDocChars) {
        content = content.slice(0, maxDocChars) + "\n\n<!-- truncated -->";
      }
      docs.push({ name: extra.name, content });
    } catch {
      /* ignore */
    }
  }

  if (docs.length > 0) {
    ctx.systemDocs = docs;
  }

  return ctx;
}

/**
 * Best-effort guard preset detection. Looks at two common config
 * files. Returns undefined if nothing matched.
 */
function detectGuardPreset(repoRoot: string): string | undefined {
  const candidates = [
    join(repoRoot, "guard.config.ts"),
    join(repoRoot, "guard.config.js"),
    join(repoRoot, "mandu.config.ts"),
    join(repoRoot, "mandu.config.js"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      const match = content.match(/preset\s*:\s*['"]([a-z]+)['"]/);
      if (match) {
        return match[1];
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Render a `PromptContext` as a structured XML block suitable for inclusion
 * in a system or user prompt. Claude + other models both respect tag
 * structure — this keeps prompts consistent across providers.
 */
export function renderContextAsXml(ctx: PromptContext | undefined): string {
  if (!ctx) return "";
  const out: string[] = ["<project_context>"];

  if (ctx.repoRoot) {
    out.push(`  <repo_root>${escapeXml(ctx.repoRoot)}</repo_root>`);
  }

  if (ctx.manifest?.routes?.length) {
    out.push(`  <routes count="${ctx.manifest.routes.length}">`);
    for (const route of ctx.manifest.routes.slice(0, 50)) {
      const methods = route.methods?.join(",") ?? "";
      out.push(
        `    <route id="${escapeXml(route.id)}"${route.pattern ? ` pattern="${escapeXml(route.pattern)}"` : ""}${route.kind ? ` kind="${escapeXml(route.kind)}"` : ""}${methods ? ` methods="${escapeXml(methods)}"` : ""} />`,
      );
    }
    out.push("  </routes>");
  }

  if (ctx.resources?.length) {
    out.push(`  <resources>`);
    for (const r of ctx.resources.slice(0, 30)) {
      out.push(`    <resource name="${escapeXml(r.name)}" />`);
    }
    out.push("  </resources>");
  }

  if (ctx.guardPreset) {
    out.push(`  <guard preset="${escapeXml(ctx.guardPreset)}" />`);
  }

  if (ctx.guardViolations?.length) {
    out.push(`  <guard_violations count="${ctx.guardViolations.length}">`);
    for (const v of ctx.guardViolations.slice(0, 20)) {
      out.push(
        `    <violation rule="${escapeXml(v.ruleId)}" file="${escapeXml(v.file)}" severity="${v.severity ?? "error"}">${escapeXml(v.message)}</violation>`,
      );
    }
    out.push("  </guard_violations>");
  }

  if (ctx.meta && Object.keys(ctx.meta).length > 0) {
    out.push("  <meta>");
    for (const [k, v] of Object.entries(ctx.meta)) {
      out.push(`    <${escapeTagName(k)}>${escapeXml(String(v))}</${escapeTagName(k)}>`);
    }
    out.push("  </meta>");
  }

  out.push("</project_context>");
  return out.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeTagName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

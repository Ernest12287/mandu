/**
 * MCP tool — `mandu.ai.brief`
 *
 * Assembles a structured briefing for an AI agent joining a project:
 *   - project title + summary (from `package.json` / `mandu.config`)
 *   - skills manifest (static `@mandujs/skills` list + any generated
 *     per-project skills under `.claude/skills/`)
 *   - recent changes (last 20 git commits — subject + hash + author)
 *   - relevant docs index (top-level `docs/` headings)
 *   - suggested next-steps derived from existing recent-activity signals
 *
 * Invariants:
 *   - Read-only. Never writes files, never spawns long-running processes.
 *   - Returns a structured JSON shape — the MCP client renders as needed.
 *   - Fails soft: missing `docs/` or `git` history produces empty fields,
 *     not an error.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "bun";
import path from "path";
import fs from "fs/promises";
import { readConfig } from "../utils/project.js";

type Depth = "short" | "full";

interface AiBriefInput {
  depth?: Depth;
}

interface SkillEntry {
  id: string;
  source: "static" | "generated";
  path?: string;
}

interface CommitEntry {
  hash: string;
  subject: string;
  author?: string;
  date?: string;
}

interface DocEntry {
  path: string;
  title: string;
}

interface AiBriefResult {
  title: string;
  summary: string;
  depth: Depth;
  files: string[];
  skills: SkillEntry[];
  recent_changes: CommitEntry[];
  docs: DocEntry[];
  config: {
    guard_preset?: string;
    fs_routes?: boolean;
    has_playwright?: boolean;
  };
  suggested_next: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────

function validateInput(raw: Record<string, unknown>): {
  ok: true;
  depth: Depth;
} | { ok: false; error: string; field: string; hint: string } {
  const depth = raw.depth ?? "short";
  if (typeof depth !== "string" || (depth !== "short" && depth !== "full")) {
    return {
      ok: false,
      error: "'depth' must be 'short' or 'full'",
      field: "depth",
      hint: "Omit to default to 'short'",
    };
  }
  return { ok: true, depth: depth as Depth };
}

// ─────────────────────────────────────────────────────────────────────────
// Data collectors
// ─────────────────────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPackageInfo(projectRoot: string): Promise<{
  name: string;
  description: string;
  version?: string;
}> {
  const pkgPath = path.join(projectRoot, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      name?: string;
      description?: string;
      version?: string;
    };
    return {
      name: pkg.name ?? path.basename(projectRoot),
      description: pkg.description ?? "",
      ...(pkg.version ? { version: pkg.version } : {}),
    };
  } catch {
    return { name: path.basename(projectRoot), description: "" };
  }
}

/**
 * Discover the static skill catalog. Prefer `@mandujs/skills/SKILL_IDS`
 * when reachable, else fall back to a hard-coded canonical list. We
 * deliberately avoid importing the skills package at module-eval time
 * to keep the MCP server startup fast — the list is tiny.
 */
const STATIC_SKILL_IDS: readonly string[] = [
  "mandu-create-feature",
  "mandu-create-api",
  "mandu-debug",
  "mandu-explain",
  "mandu-guard-guide",
  "mandu-deploy",
  "mandu-slot",
  "mandu-fs-routes",
  "mandu-hydration",
];

async function collectSkills(projectRoot: string): Promise<SkillEntry[]> {
  const out: SkillEntry[] = STATIC_SKILL_IDS.map((id) => ({
    id,
    source: "static" as const,
  }));

  const skillsDir = path.join(projectRoot, ".claude", "skills");
  if (!(await fileExists(skillsDir))) return out;

  try {
    const entries = await fs.readdir(skillsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      out.push({
        id: entry.replace(/\.md$/, ""),
        source: "generated",
        path: path.join(skillsDir, entry),
      });
    }
  } catch {
    // ignore
  }
  return out;
}

async function collectRecentCommits(
  projectRoot: string,
  limit: number,
): Promise<CommitEntry[]> {
  const proc = spawn(
    [
      "git",
      "log",
      `-${limit}`,
      "--pretty=format:%H%x09%s%x09%an%x09%ad",
      "--date=short",
    ],
    {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let timedOut = false;
  const handle = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, 10_000);

  try {
    const [stdout, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (timedOut || exit !== 0 || !stdout) return [];

    const commits: CommitEntry[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [hash, subject, author, date] = line.split("\t");
      if (!hash || !subject) continue;
      commits.push({
        hash: hash.slice(0, 12),
        subject,
        ...(author ? { author } : {}),
        ...(date ? { date } : {}),
      });
    }
    return commits;
  } catch {
    return [];
  } finally {
    clearTimeout(handle);
  }
}

async function collectDocs(projectRoot: string, limit: number): Promise<DocEntry[]> {
  const docsDir = path.join(projectRoot, "docs");
  if (!(await fileExists(docsDir))) return [];

  const out: DocEntry[] = [];
  try {
    const entries = await fs.readdir(docsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const p = path.join(docsDir, entry.name);
        const title = await extractMarkdownTitle(p, entry.name);
        out.push({ path: p, title });
      }
    }
  } catch {
    // ignore
  }

  // Sort alphabetically for determinism, cap to `limit`.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

async function extractMarkdownTitle(
  filePath: string,
  fallback: string,
): Promise<string> {
  try {
    // Read only the first ~4KB — title is always near the top.
    const file = Bun.file(filePath);
    const head = await file.slice(0, 4096).text();
    const match = /^#\s+(.+)$/m.exec(head);
    if (match) return match[1].trim();
  } catch {
    // ignore
  }
  return fallback;
}

async function collectConfigSummary(projectRoot: string): Promise<{
  guard_preset?: string;
  fs_routes?: boolean;
  has_playwright?: boolean;
}> {
  const summary: {
    guard_preset?: string;
    fs_routes?: boolean;
    has_playwright?: boolean;
  } = {};
  try {
    const cfg = await readConfig(projectRoot);
    if (cfg && typeof cfg === "object") {
      const guard = (cfg as { guard?: { preset?: unknown } }).guard;
      if (guard && typeof guard === "object") {
        const preset = (guard as { preset?: unknown }).preset;
        if (typeof preset === "string") summary.guard_preset = preset;
      }
      const fsRoutes = (cfg as { fsRoutes?: unknown }).fsRoutes;
      if (typeof fsRoutes === "boolean") summary.fs_routes = fsRoutes;
    }
  } catch {
    // ignore
  }

  try {
    const pkgPath = path.join(projectRoot, "package.json");
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const allDeps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    if ("@playwright/test" in allDeps || "playwright" in allDeps) {
      summary.has_playwright = true;
    }
  } catch {
    // ignore
  }

  return summary;
}

function buildSuggestedNext(args: {
  commits: CommitEntry[];
  guardPreset?: string;
  hasGeneratedSkills: boolean;
}): string[] {
  const out: string[] = [];

  // If there are no generated skills, suggest creating them.
  if (!args.hasGeneratedSkills) {
    out.push(
      "Run `mandu skills:generate` to emit project-specific `.claude/skills/` files (domain glossary, conventions, workflow).",
    );
  }

  // If the most recent commit mentions "WIP", suggest continuing that work.
  const wip = args.commits.find((c) => /\bWIP\b/i.test(c.subject));
  if (wip) {
    out.push(
      `Continue the WIP work referenced by \`${wip.hash}\` — "${wip.subject}".`,
    );
  }

  // Always suggest running tests as a safe baseline.
  out.push(
    "Run `mandu_run_tests` with `{target:'all'}` to establish a green baseline before making changes.",
  );

  // If a guard preset is configured, surface it.
  if (args.guardPreset) {
    out.push(
      `Respect the \`${args.guardPreset}\` architecture preset when proposing changes — run \`mandu.guard.check\` to confirm compliance.`,
    );
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────

async function buildAiBrief(
  projectRoot: string,
  input: AiBriefInput,
): Promise<AiBriefResult | { error: string; field?: string; hint?: string }> {
  const validated = validateInput(input as Record<string, unknown>);
  if (!validated.ok) {
    return {
      error: validated.error,
      field: validated.field,
      hint: validated.hint,
    };
  }

  const depth = validated.depth;
  const pkg = await readPackageInfo(projectRoot);
  const skills = await collectSkills(projectRoot);
  const commits = await collectRecentCommits(projectRoot, 20);
  const docsLimit = depth === "full" ? 40 : 10;
  const docs = await collectDocs(projectRoot, docsLimit);
  const config = await collectConfigSummary(projectRoot);

  const files: string[] = [];
  const pkgPath = path.join(projectRoot, "package.json");
  if (await fileExists(pkgPath)) files.push(pkgPath);
  for (const cfgName of ["mandu.config.ts", "mandu.config.js", "mandu.config.json"]) {
    const p = path.join(projectRoot, cfgName);
    if (await fileExists(p)) files.push(p);
  }
  const manifestPath = path.join(projectRoot, ".mandu", "routes.manifest.json");
  if (await fileExists(manifestPath)) files.push(manifestPath);
  const agentsMd = path.join(projectRoot, "AGENTS.md");
  if (await fileExists(agentsMd)) files.push(agentsMd);
  const claudeMd = path.join(projectRoot, "CLAUDE.md");
  if (await fileExists(claudeMd)) files.push(claudeMd);

  const title = pkg.name + (pkg.version ? ` @ ${pkg.version}` : "");
  const summary = pkg.description ||
    "A Mandu project — Bun-native TypeScript full-stack framework.";

  const hasGeneratedSkills = skills.some((s) => s.source === "generated");
  const suggested_next = buildSuggestedNext({
    commits,
    guardPreset: config.guard_preset,
    hasGeneratedSkills,
  });

  const result: AiBriefResult = {
    title,
    summary,
    depth,
    files,
    skills,
    recent_changes: commits,
    docs,
    config,
    suggested_next,
  };

  // In "short" depth, trim the most verbose collections.
  if (depth === "short") {
    result.skills = result.skills.slice(0, 12);
    result.recent_changes = result.recent_changes.slice(0, 5);
    result.docs = result.docs.slice(0, 5);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// MCP tool definition + handler map
// ─────────────────────────────────────────────────────────────────────────

export const aiBriefToolDefinitions: Tool[] = [
  {
    name: "mandu.ai.brief",
    description:
      "Assemble an AI agent briefing: project title, description, skills manifest, last 20 git commits, docs/ index, and config snapshot. Pass `depth:'full'` for the unabridged view; default `short` keeps the payload small. Read-only.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        depth: {
          type: "string",
          enum: ["short", "full"],
          description: "Brief depth — `short` (default) trims lists for fast ingestion; `full` returns the complete view.",
        },
      },
      required: [],
    },
  },
];

export function aiBriefTools(projectRoot: string) {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    "mandu.ai.brief": async (args) => buildAiBrief(projectRoot, args as AiBriefInput),
  };
  return handlers;
}

// Exported for unit tests
export { buildSuggestedNext };

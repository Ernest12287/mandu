import { execFileSync } from "node:child_process";
import { resolve, relative, extname, basename, dirname } from "node:path";
import { getAtePaths, readJson } from "./fs";
import type { InteractionGraph, InteractionNode } from "./types";
import { buildDependencyGraph, findDependents } from "./dep-graph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmartSelectInput {
  repoRoot: string;
  /** If not provided, uses `git diff HEAD --name-only` to detect uncommitted changes. */
  changedFiles?: string[];
  /** Maximum number of routes to return. Default: 10 */
  maxRoutes?: number;
}

export interface SmartSelectResult {
  selectedRoutes: string[];
  /** routeId -> human-readable explanation of why it was selected */
  reasoning: Record<string, string>;
  totalAffected: number;
}

// ---------------------------------------------------------------------------
// Priority scoring
// ---------------------------------------------------------------------------

type PriorityLevel = "HIGH" | "MEDIUM" | "LOW";

interface ScoredRoute {
  routeId: string;
  score: number;
  reasons: string[];
}

const PRIORITY_SCORES: Record<PriorityLevel, number> = {
  HIGH: 100,
  MEDIUM: 50,
  LOW: 10,
};

// ---------------------------------------------------------------------------
// File classification helpers
// ---------------------------------------------------------------------------

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizePath(path: string, rootDir: string): string {
  const abs = resolve(rootDir, path);
  return abs.replace(/\\/g, "/");
}

function classifyFile(filePath: string): { priority: PriorityLevel; category: string } {
  const posix = toPosixPath(filePath);
  const ext = extname(posix);
  const base = basename(posix);

  // Contract files (.contract.ts, .contract.tsx) affect all routes importing them
  if (base.includes(".contract.")) {
    return { priority: "HIGH", category: "contract" };
  }

  // Guard-related files
  if (posix.includes("/guard/") || base.includes(".guard.")) {
    return { priority: "HIGH", category: "guard" };
  }

  // API route files (route.ts under app/ or routes/)
  if (base === "route.ts" && (posix.includes("/app/") || posix.includes("/routes/"))) {
    return { priority: "MEDIUM", category: "api-route" };
  }

  // Page files
  if (base === "page.tsx" && (posix.includes("/app/") || posix.includes("/routes/"))) {
    return { priority: "MEDIUM", category: "page" };
  }

  // Layout files
  if (base === "layout.tsx" || base === "layout.ts") {
    return { priority: "MEDIUM", category: "layout" };
  }

  // Island / client component files
  if (base.includes(".island.") || base.includes(".client.")) {
    return { priority: "MEDIUM", category: "island" };
  }

  // Slot files (server-side data loaders)
  if (base.includes(".slot.")) {
    return { priority: "MEDIUM", category: "slot" };
  }

  // Shared / utility / lib files have broad but lower-priority impact
  if (
    posix.includes("/shared/") ||
    posix.includes("/utils/") ||
    posix.includes("/lib/") ||
    posix.includes("/helpers/") ||
    posix.includes("/common/")
  ) {
    return { priority: "LOW", category: "shared" };
  }

  // Config / non-source files
  if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    return { priority: "LOW", category: "non-source" };
  }

  return { priority: "LOW", category: "other" };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getChangedFilesFromGit(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "HEAD", "--name-only"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8");

    const files = out
      .split("\n")
      .map((s) => toPosixPath(s.trim()))
      .filter(Boolean);

    // Also include untracked files so that brand-new routes are picked up
    const untrackedOut = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8");

    const untracked = untrackedOut
      .split("\n")
      .map((s) => toPosixPath(s.trim()))
      .filter(Boolean);

    return [...new Set([...files, ...untracked])];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function smartSelectRoutes(input: SmartSelectInput): Promise<SmartSelectResult> {
  const { repoRoot, maxRoutes = 10 } = input;

  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }

  // 1. Determine changed files
  const changedFiles = input.changedFiles
    ? input.changedFiles.map((f) => toPosixPath(f))
    : getChangedFilesFromGit(repoRoot);

  if (changedFiles.length === 0) {
    return { selectedRoutes: [], reasoning: {}, totalAffected: 0 };
  }

  // 2. Load interaction graph
  const paths = getAtePaths(repoRoot);
  let graph: InteractionGraph;
  try {
    graph = readJson<InteractionGraph>(paths.interactionGraphPath);
  } catch {
    // No interaction graph available -- fall back to empty result
    return { selectedRoutes: [], reasoning: {}, totalAffected: 0 };
  }

  const routes = graph.nodes.filter(
    (n): n is Extract<InteractionNode, { kind: "route" }> => n.kind === "route",
  );

  if (routes.length === 0) {
    return { selectedRoutes: [], reasoning: {}, totalAffected: 0 };
  }

  // 3. Build dependency graph for transitive analysis (best-effort)
  let depGraph: Awaited<ReturnType<typeof buildDependencyGraph>> | null = null;
  try {
    depGraph = await buildDependencyGraph({
      rootDir: repoRoot,
      include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
      exclude: ["**/node_modules/**", "**/*.test.ts", "**/*.spec.ts"],
    });
  } catch {
    // Continue without transitive analysis
  }

  // 4. Score every route
  const routeScores = new Map<string, ScoredRoute>();

  function addScore(routeId: string, priority: PriorityLevel, reason: string): void {
    let entry = routeScores.get(routeId);
    if (!entry) {
      entry = { routeId, score: 0, reasons: [] };
      routeScores.set(routeId, entry);
    }
    entry.score += PRIORITY_SCORES[priority];
    entry.reasons.push(reason);
  }

  for (const changedFile of changedFiles) {
    const normalizedChanged = normalizePath(changedFile, repoRoot);
    const { priority, category } = classifyFile(changedFile);

    // Direct route-file match
    for (const r of routes) {
      const routeFile = normalizePath(r.file, repoRoot);
      if (normalizedChanged === routeFile) {
        addScore(r.id, "HIGH", `direct change to route file: ${changedFile}`);
      }
    }

    // Transitive impact via dependency graph
    if (depGraph) {
      const affected = findDependents(depGraph, normalizedChanged);
      for (const affectedFile of affected) {
        for (const r of routes) {
          const routeFile = normalizePath(r.file, repoRoot);
          if (affectedFile === routeFile) {
            addScore(r.id, priority, `${category} change (${changedFile}) transitively affects route`);
          }
        }
      }
    }

    // For shared/utility files with LOW priority, cap to top 5 affected routes
    // (already handled by the final sort + maxRoutes, but we add a small reason)
    if (category === "shared" && !depGraph) {
      // Without a dep graph, we cannot know which routes are affected.
      // Conservatively mark all routes with a minimal score.
      for (const r of routes) {
        addScore(r.id, "LOW", `shared file changed without dep graph: ${changedFile}`);
      }
    }
  }

  // 5. Sort by score descending, then alphabetically for stability
  const sorted = Array.from(routeScores.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.routeId.localeCompare(b.routeId);
  });

  const totalAffected = sorted.length;
  const selected = sorted.slice(0, maxRoutes);

  const reasoning: Record<string, string> = {};
  for (const entry of selected) {
    reasoning[entry.routeId] = entry.reasons.join("; ");
  }

  return {
    selectedRoutes: selected.map((s) => s.routeId),
    reasoning,
    totalAffected,
  };
}

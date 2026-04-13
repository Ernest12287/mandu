import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { smartSelectRoutes } from "./smart-select";
import { getAtePaths } from "./fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrecommitInput {
  repoRoot: string;
  /** Override staged files instead of reading from git. Useful for testing. */
  stagedFiles?: string[];
}

export interface PrecommitResult {
  shouldTest: boolean;
  routes: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Get staged (cached) files from git.
 */
function getStagedFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8");

    return out
      .split("\n")
      .map((s) => toPosixPath(s.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check whether a given set of routes already has corresponding test specs
 * under the auto or manual E2E directories.
 */
function findRoutesWithoutTests(repoRoot: string, routeIds: string[]): string[] {
  const paths = getAtePaths(repoRoot);
  const specDirs = [paths.autoE2eDir, paths.manualE2eDir];

  // Collect all route references from existing specs
  const testedRoutes = new Set<string>();

  for (const dir of specDirs) {
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".spec.ts") || f.endsWith(".test.ts"));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf8");
        // Extract route-like string literals
        const routePattern = /["'`](\/[a-zA-Z0-9/_-]*)["'`]/g;
        let match: RegExpExecArray | null;
        while ((match = routePattern.exec(content)) !== null) {
          testedRoutes.add(match[1]);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return routeIds.filter((id) => !testedRoutes.has(id));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pre-commit hook helper.
 *
 * 1. Reads staged files from `git diff --cached --name-only` (or uses provided list)
 * 2. Runs smartSelectRoutes against those files
 * 3. Checks whether the selected routes have existing test specs
 * 4. Returns `shouldTest: true` if affected routes lack test coverage
 *
 * @param repoRootOrInput - Either a string (repoRoot) or a PrecommitInput object
 */
export async function precommitCheck(repoRootOrInput: string | PrecommitInput): Promise<PrecommitResult> {
  const input = typeof repoRootOrInput === "string"
    ? { repoRoot: repoRootOrInput }
    : repoRootOrInput;

  const { repoRoot } = input;

  if (!repoRoot) {
    throw new Error("repoRoot is required");
  }

  // 1. Get staged files
  const stagedFiles = input.stagedFiles ?? getStagedFiles(repoRoot);

  if (stagedFiles.length === 0) {
    return {
      shouldTest: false,
      routes: [],
      reason: "No staged files detected.",
    };
  }

  // Filter to source files only -- non-source changes (docs, configs) are
  // unlikely to break routes.
  const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
  const sourceFiles = stagedFiles.filter((f) => {
    const ext = f.lastIndexOf(".");
    return ext !== -1 && sourceExtensions.has(f.slice(ext));
  });

  if (sourceFiles.length === 0) {
    return {
      shouldTest: false,
      routes: [],
      reason: "Staged files contain no source code changes.",
    };
  }

  // 2. Run smart selection
  let selectedRoutes: string[];
  try {
    const result = await smartSelectRoutes({
      repoRoot,
      changedFiles: sourceFiles,
      maxRoutes: 20, // generous limit for pre-commit
    });
    selectedRoutes = result.selectedRoutes;
  } catch {
    // If smart selection fails, be conservative and recommend testing
    return {
      shouldTest: true,
      routes: [],
      reason: "Smart route selection failed; recommend running full test suite.",
    };
  }

  if (selectedRoutes.length === 0) {
    return {
      shouldTest: false,
      routes: [],
      reason: "No routes affected by staged changes.",
    };
  }

  // 3. Check for routes without existing tests
  const untestedRoutes = findRoutesWithoutTests(repoRoot, selectedRoutes);

  if (untestedRoutes.length === 0) {
    return {
      shouldTest: false,
      routes: selectedRoutes,
      reason: `All ${selectedRoutes.length} affected route(s) have existing tests.`,
    };
  }

  return {
    shouldTest: true,
    routes: untestedRoutes,
    reason: `${untestedRoutes.length} affected route(s) have no test coverage: ${untestedRoutes.join(", ")}`,
  };
}

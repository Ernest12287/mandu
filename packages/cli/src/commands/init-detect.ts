/**
 * Project state detection for `mandu init` (retrofit) and `mandu create`
 * (new-folder scaffold).
 *
 * Phase 2 introduces a meaningful split between the two commands:
 *   - `mandu create <name>` keeps the legacy "scaffold a fresh project
 *     into a new folder" behaviour.
 *   - `mandu init` (no name) becomes a *retrofit*: drop Mandu structure
 *     into the **current** directory.
 *
 * The retrofit path is only safe when we know what kind of folder we're
 * pointed at. Empty folders are trivially safe; folders with a foreign
 * framework already in place are not. This module classifies the cwd
 * and reports an action recommendation; the caller decides whether to
 * proceed, prompt, or abort.
 *
 * No filesystem writes happen here — pure detection.
 */

import path from "node:path";
import fs from "node:fs/promises";

/**
 * Classification of a candidate directory for Mandu retrofit.
 */
export type ProjectKind =
  /** Directory is empty (or only contains hidden dotfiles like `.git`). */
  | "empty"
  /** `package.json` exists, but no foreign framework or Mandu markers. */
  | "barePackageJson"
  /** Already a Mandu project — has `@mandujs/core` in package.json deps. */
  | "manduProject"
  /** Next.js project — has `next` in deps or a `next.config.*`. */
  | "nextProject"
  /** Vite project — has `vite` in deps or a `vite.config.*`. */
  | "viteProject"
  /** Remix project — has `@remix-run/*` in deps or a `remix.config.*`. */
  | "remixProject"
  /** No clear classification — partial mandu structure or unknown tooling. */
  | "polyglot";

/**
 * Recommendation that pairs with a `ProjectKind`.
 *
 * - `retrofit` — safe to proceed; caller may write Mandu files.
 * - `abort`     — refuse to proceed; user must intervene manually.
 * - `force-required` — refuse unless the caller passes an explicit
 *   override (e.g. `--force`). Used for ambiguous states where retrofit
 *   *might* be what the user wants but the risk of overwriting work is
 *   high.
 */
export type SuggestedAction = "retrofit" | "abort" | "force-required";

export interface ProjectAnalysis {
  kind: ProjectKind;
  /**
   * Paths (relative to cwd) of files that would conflict with a
   * default Mandu scaffold. Even on `retrofit`-class directories,
   * the caller may want to surface these as "will keep existing".
   */
  conflicts: string[];
  /** What the caller should do by default. */
  suggestedAction: SuggestedAction;
  /** One-line human-readable explanation, suitable for CLI output. */
  reason: string;
}

/**
 * Files Mandu writes during retrofit. Used purely for conflict
 * reporting — the actual write set lives in the retrofit module.
 */
const MANDU_SCAFFOLD_PATHS = [
  "app",
  "bunfig.toml",
  "tsconfig.json",
  ".oxlintrc.json",
  "lefthook.yml",
  "scripts",
  "spec",
  "src",
  "tests",
  "AGENTS.md",
] as const;

/**
 * Filenames that, when present at the top level, identify a foreign
 * framework. The classifier matches any of these prefixes followed by
 * `.js`, `.ts`, `.mjs`, or `.cjs`.
 */
const FRAMEWORK_CONFIG_BASENAMES = {
  next: "next.config",
  vite: "vite.config",
  remix: "remix.config",
} as const;

const CONFIG_EXTENSIONS = [".js", ".ts", ".mjs", ".cjs", ".mts"] as const;

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Detect the project kind for a given directory.
 *
 * @param cwd Absolute path to the directory under consideration.
 *            Defaults to `process.cwd()`.
 */
export async function detectProject(
  cwd: string = process.cwd()
): Promise<ProjectAnalysis> {
  const entries = await readDirSafe(cwd);
  const visibleEntries = entries.filter((name) => !isIgnorableEntry(name));
  const conflicts = await collectConflicts(cwd, entries);

  if (visibleEntries.length === 0) {
    return {
      kind: "empty",
      conflicts: [],
      suggestedAction: "retrofit",
      reason: "directory is empty",
    };
  }

  const packageJsonPath = path.join(cwd, "package.json");
  const pkg = await readPackageJson(packageJsonPath);

  // Foreign framework detection takes priority over `manduProject`.
  // A folder containing both `@mandujs/core` and `next.config.ts` is
  // suspicious enough that we'd rather abort than retrofit on top.
  const frameworkKind = detectFrameworkKind(entries, pkg);
  if (frameworkKind) {
    return {
      kind: frameworkKind,
      conflicts,
      suggestedAction: "abort",
      reason: foreignFrameworkReason(frameworkKind),
    };
  }

  if (pkg && hasManduCore(pkg)) {
    return {
      kind: "manduProject",
      conflicts,
      suggestedAction: "abort",
      reason: "already a Mandu project (@mandujs/core in package.json)",
    };
  }

  if (pkg && conflicts.length === 0) {
    return {
      kind: "barePackageJson",
      conflicts: [],
      suggestedAction: "retrofit",
      reason: "package.json only; will merge Mandu deps and write scaffold",
    };
  }

  if (pkg && conflicts.length > 0) {
    return {
      kind: "polyglot",
      conflicts,
      suggestedAction: "force-required",
      reason: `existing files would be overwritten: ${conflicts.join(", ")}`,
    };
  }

  // No package.json but the directory is not empty — surprising state,
  // most likely an in-progress checkout or a sibling tool's output.
  // Force-required keeps the user in control.
  return {
    kind: "polyglot",
    conflicts,
    suggestedAction: "force-required",
    reason: "no package.json but directory is not empty",
  };
}

async function readDirSafe(cwd: string): Promise<string[]> {
  try {
    return await fs.readdir(cwd);
  } catch {
    return [];
  }
}

/**
 * Hidden / VCS / OS-level entries that should not influence
 * "is this directory empty" decisions.
 */
function isIgnorableEntry(name: string): boolean {
  if (name === ".git") return true;
  if (name === ".gitignore") return true;
  if (name === ".gitattributes") return true;
  if (name === ".github") return true;
  if (name === ".DS_Store") return true;
  if (name === "Thumbs.db") return true;
  return false;
}

async function collectConflicts(
  cwd: string,
  entries: string[]
): Promise<string[]> {
  const present = new Set(entries);
  return MANDU_SCAFFOLD_PATHS.filter((name) => present.has(name));
}

async function readPackageJson(
  packageJsonPath: string
): Promise<PackageJsonShape | null> {
  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as PackageJsonShape;
    }
    return null;
  } catch {
    return null;
  }
}

function hasDependency(pkg: PackageJsonShape, name: string): boolean {
  if (pkg.dependencies?.[name]) return true;
  if (pkg.devDependencies?.[name]) return true;
  if (pkg.peerDependencies?.[name]) return true;
  return false;
}

function hasManduCore(pkg: PackageJsonShape): boolean {
  return hasDependency(pkg, "@mandujs/core");
}

function detectFrameworkKind(
  entries: string[],
  pkg: PackageJsonShape | null
): "nextProject" | "viteProject" | "remixProject" | null {
  if (hasFrameworkConfig(entries, FRAMEWORK_CONFIG_BASENAMES.next)) {
    return "nextProject";
  }
  if (hasFrameworkConfig(entries, FRAMEWORK_CONFIG_BASENAMES.vite)) {
    return "viteProject";
  }
  if (hasFrameworkConfig(entries, FRAMEWORK_CONFIG_BASENAMES.remix)) {
    return "remixProject";
  }
  if (!pkg) return null;
  if (hasDependency(pkg, "next")) return "nextProject";
  if (hasDependency(pkg, "vite")) return "viteProject";
  if (
    hasDependency(pkg, "@remix-run/dev") ||
    hasDependency(pkg, "@remix-run/node") ||
    hasDependency(pkg, "@remix-run/react")
  ) {
    return "remixProject";
  }
  return null;
}

function hasFrameworkConfig(entries: string[], basename: string): boolean {
  return entries.some((entry) =>
    CONFIG_EXTENSIONS.some((ext) => entry === `${basename}${ext}`)
  );
}

function foreignFrameworkReason(
  kind: "nextProject" | "viteProject" | "remixProject"
): string {
  const label =
    kind === "nextProject"
      ? "Next.js"
      : kind === "viteProject"
        ? "Vite"
        : "Remix";
  return `${label} project detected; manual migration required`;
}

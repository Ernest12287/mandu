/**
 * Pure merge function for `mandu init` retrofit.
 *
 * Mandu retrofit needs to install a known set of dependencies and a
 * known set of npm scripts into an existing `package.json`. Doing that
 * naively (overwrite-and-pray) is dangerous — the user may already have
 * `dev` / `build` scripts that mean something else, or pinned versions
 * of `react` we shouldn't silently bump.
 *
 * Policy:
 *   - **deps / devDeps**: if the package is already listed, keep the
 *     existing version (record a warning). If absent, add Mandu's
 *     version. `force: true` flips the policy — Mandu's version wins.
 *   - **scripts**: if the script name is already taken, keep the
 *     existing entry (record a warning). `force: true` overwrites.
 *   - All other top-level fields on the existing `package.json` are
 *     preserved verbatim. Mandu does not touch `version`, `name`,
 *     `description`, etc.
 *
 * The function is pure — it returns a new object plus diagnostics.
 * The caller decides whether to write it.
 */

export interface PackageJsonShape {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  // Permit arbitrary additional fields so the merger can preserve them.
  [key: string]: unknown;
}

export interface ManduManifest {
  /** Production deps Mandu needs (e.g. `@mandujs/core`, `react`). */
  dependencies: Record<string, string>;
  /** Dev deps Mandu wants installed (e.g. `oxlint`, `lefthook`). */
  devDependencies?: Record<string, string>;
  /** Scripts Mandu wants registered (e.g. `dev: "mandu dev"`). */
  scripts: Record<string, string>;
}

export interface MergeOptions {
  /**
   * When `true`, Mandu's versions / scripts win on conflict and no
   * warning is emitted for those slots. Used when the caller passes
   * `--force` on the CLI.
   */
  force?: boolean;
}

export interface MergeWarning {
  kind: "kept-existing-dep" | "kept-existing-script";
  /** The dep name or script name that was kept. */
  name: string;
  /** The value the existing package.json carries. */
  existing: string;
  /** The value Mandu would have written. */
  proposed: string;
}

export interface MergeResult {
  merged: PackageJsonShape;
  warnings: MergeWarning[];
  /**
   * Names that resolved to a real conflict (existing != proposed).
   * A subset of `warnings` keyed by name. Surfaces in `--dry-run`
   * output so the user sees the diff at a glance.
   */
  conflicts: string[];
}

/**
 * Merge Mandu's required pieces into an existing (possibly empty)
 * package.json shape. Pure — no IO.
 */
export function mergeManduIntoPackageJson(
  existing: PackageJsonShape | null | undefined,
  manifest: ManduManifest,
  options: MergeOptions = {}
): MergeResult {
  const force = options.force === true;
  const warnings: MergeWarning[] = [];
  const conflicts: string[] = [];

  const base: PackageJsonShape = existing ? { ...existing } : {};

  base.dependencies = mergeDeps(
    base.dependencies,
    manifest.dependencies,
    "kept-existing-dep",
    { force, warnings, conflicts }
  );

  if (manifest.devDependencies) {
    base.devDependencies = mergeDeps(
      base.devDependencies,
      manifest.devDependencies,
      "kept-existing-dep",
      { force, warnings, conflicts }
    );
  }

  base.scripts = mergeScripts(base.scripts, manifest.scripts, {
    force,
    warnings,
    conflicts,
  });

  return { merged: base, warnings, conflicts };
}

interface MergeAccumulator {
  force: boolean;
  warnings: MergeWarning[];
  conflicts: string[];
}

function mergeDeps(
  existing: Record<string, string> | undefined,
  proposed: Record<string, string>,
  warningKind: MergeWarning["kind"],
  acc: MergeAccumulator
): Record<string, string> {
  const out: Record<string, string> = { ...(existing ?? {}) };
  for (const [name, proposedVersion] of Object.entries(proposed)) {
    const existingVersion = out[name];
    if (existingVersion === undefined) {
      out[name] = proposedVersion;
      continue;
    }
    if (existingVersion === proposedVersion) {
      // Already aligned — nothing to record.
      continue;
    }
    if (acc.force) {
      out[name] = proposedVersion;
      continue;
    }
    acc.warnings.push({
      kind: warningKind,
      name,
      existing: existingVersion,
      proposed: proposedVersion,
    });
    acc.conflicts.push(name);
  }
  return out;
}

function mergeScripts(
  existing: Record<string, string> | undefined,
  proposed: Record<string, string>,
  acc: MergeAccumulator
): Record<string, string> {
  const out: Record<string, string> = { ...(existing ?? {}) };
  for (const [name, proposedValue] of Object.entries(proposed)) {
    const existingValue = out[name];
    if (existingValue === undefined) {
      out[name] = proposedValue;
      continue;
    }
    if (existingValue === proposedValue) continue;
    if (acc.force) {
      out[name] = proposedValue;
      continue;
    }
    acc.warnings.push({
      kind: "kept-existing-script",
      name,
      existing: existingValue,
      proposed: proposedValue,
    });
    acc.conflicts.push(name);
  }
  return out;
}

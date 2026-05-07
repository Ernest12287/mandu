/**
 * `mandu init` retrofit — drop Mandu structure into the **current**
 * directory.
 *
 * This is the new behaviour for `mandu init` (no positional name)
 * introduced by Phase 2 of the init/create split. The legacy
 * "scaffold a fresh project into a new folder" path keeps living
 * under `mandu create <name>` (see `init.ts`'s `init()` function).
 *
 * Retrofit is intentionally minimal — it writes only what's needed
 * for `mandu dev` to start in the current folder:
 *
 *   - `package.json`           — merged with Mandu's required deps + scripts
 *                                (existing entries preserved unless --force)
 *   - `app/page.tsx`           — fallback entry route, only if app/page.tsx
 *                                doesn't already exist
 *
 * Anything else (tsconfig, bunfig, lefthook, oxlint, AGENTS.md) is
 * left for the user to add as they need it. This keeps retrofit
 * predictable: low blast radius, easy to rollback by reverting the
 * package.json change and deleting `app/`.
 */

import path from "node:path";
import fs from "node:fs/promises";

import { detectProject, type ProjectAnalysis } from "./init-detect";
import {
  mergeManduIntoPackageJson,
  type ManduManifest,
  type MergeWarning,
  type PackageJsonShape,
} from "./init-merge-package-json";
import { resolvePackageVersions } from "./init";
import { theme } from "../terminal/theme";

export interface RetrofitOptions {
  /** Directory to retrofit. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Override the conflict policy. With `force: true`, the merger
   * adopts Mandu's versions/scripts on conflict, and `app/page.tsx`
   * is overwritten if present.
   */
  force?: boolean;
  /**
   * Print the planned changes and exit without writing. The return
   * value still reflects what *would* have been written so callers
   * can use this in tests or wrappers.
   */
  dryRun?: boolean;
}

export interface RetrofitResult {
  success: boolean;
  /** Files that would (or did) get written, relative to cwd. */
  written: string[];
  /** Files that already existed and were preserved (no --force). */
  skipped: string[];
  /** Human-readable warning lines for the CLI to surface. */
  warnings: string[];
  /** The detection result that drove the retrofit decision. */
  analysis: ProjectAnalysis;
}

const FALLBACK_REACT_VERSION = "^19.2.0";

/**
 * Minimal first-page template. Kept inline so retrofit doesn't depend
 * on the embedded full-template manifest used by `mandu create` —
 * those payloads are tens of KB and contain choices (Tailwind, shadcn,
 * tests, etc.) that retrofit deliberately doesn't take on the user's
 * behalf.
 */
const FALLBACK_PAGE_TSX = `// app/page.tsx — Mandu file-system route.
//
// Every \`page.tsx\` under \`app/\` becomes a route. The default export
// is a React component rendered for that route.

export default function Home() {
  return (
    <main>
      <h1>Hello from Mandu</h1>
    </main>
  );
}
`;

/**
 * Run the retrofit. Always returns a `RetrofitResult` — `success: false`
 * for the abort/force-required paths so callers can format their own
 * exit-code logic without catching exceptions.
 */
export async function retrofit(
  options: RetrofitOptions = {}
): Promise<RetrofitResult> {
  const cwd = options.cwd ?? process.cwd();
  const analysis = await detectProject(cwd);

  if (analysis.suggestedAction === "abort") {
    return {
      success: false,
      written: [],
      skipped: [],
      warnings: [analysis.reason],
      analysis,
    };
  }
  if (analysis.suggestedAction === "force-required" && !options.force) {
    return {
      success: false,
      written: [],
      skipped: [],
      warnings: [
        analysis.reason,
        "pass --force to retrofit anyway (existing files may be overwritten)",
      ],
      analysis,
    };
  }

  const manifest = await buildManifest();
  const pkgPath = path.join(cwd, "package.json");
  const existingPkg = await readPackageJson(pkgPath);
  const merge = mergeManduIntoPackageJson(existingPkg, manifest, {
    force: options.force,
  });

  const written: string[] = ["package.json"];
  const skipped: string[] = [];
  const warnings: string[] = merge.warnings.map(formatMergeWarning);

  const pagePath = path.join(cwd, "app", "page.tsx");
  const pageExists = await fileExists(pagePath);
  if (pageExists && !options.force) {
    skipped.push("app/page.tsx");
  } else {
    written.push("app/page.tsx");
  }

  if (options.dryRun) {
    return {
      success: true,
      written,
      skipped,
      warnings,
      analysis,
    };
  }

  await fs.writeFile(
    pkgPath,
    JSON.stringify(merge.merged, null, 2) + "\n",
    "utf8"
  );
  await fs.mkdir(path.join(cwd, "app"), { recursive: true });
  if (!pageExists || options.force) {
    await fs.writeFile(pagePath, FALLBACK_PAGE_TSX, "utf8");
  }

  return {
    success: true,
    written,
    skipped,
    warnings,
    analysis,
  };
}

/**
 * Render a `RetrofitResult` to stdout. Separate from `retrofit()` so
 * tests can assert on the result shape without parsing console output.
 */
export function printRetrofitResult(
  result: RetrofitResult,
  opts: { dryRun: boolean }
): void {
  if (!result.success) {
    console.error(`${theme.error("✗")} ${result.analysis.reason}`);
    for (const w of result.warnings.slice(1)) {
      console.error(`  ${w}`);
    }
    return;
  }

  const heading = opts.dryRun
    ? "🥟 Mandu Init — dry run (no files written)"
    : "🥟 Mandu Init — retrofit complete";
  console.log(theme.heading(heading));

  for (const file of result.written) {
    const verb = opts.dryRun ? "would write" : "wrote";
    console.log(`  ${theme.info("•")} ${verb} ${file}`);
  }
  for (const file of result.skipped) {
    console.log(`  ${theme.info("·")} kept existing ${file}`);
  }
  if (result.warnings.length > 0) {
    console.log("");
    console.log(theme.warn("Warnings:"));
    for (const w of result.warnings) {
      console.log(`  ${theme.warn("!")} ${w}`);
    }
  }
  if (!opts.dryRun) {
    console.log("");
    console.log("Next steps:");
    console.log("  bun install");
    console.log("  bun run dev");
  }
}

async function buildManifest(): Promise<ManduManifest> {
  let coreVersion: string;
  try {
    const versions = await resolvePackageVersions();
    coreVersion = versions.coreVersion;
  } catch {
    // Fall back to a sensible caret range if version resolution fails
    // (compiled binary edge cases). Better to retrofit with a slightly
    // generic dep than to abort.
    coreVersion = "^0.0.0";
  }
  return {
    dependencies: {
      "@mandujs/core": coreVersion.startsWith("^") ? coreVersion : `^${coreVersion}`,
      react: FALLBACK_REACT_VERSION,
      "react-dom": FALLBACK_REACT_VERSION,
    },
    scripts: {
      dev: "mandu dev",
      build: "mandu build",
      start: "mandu start",
    },
  };
}

async function readPackageJson(
  p: string
): Promise<PackageJsonShape | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PackageJsonShape;
    return null;
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function formatMergeWarning(w: MergeWarning): string {
  const slot = w.kind === "kept-existing-script" ? "script" : "dep";
  return `kept existing ${slot} "${w.name}" (existing: ${w.existing}, Mandu wanted: ${w.proposed})`;
}

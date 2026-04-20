/**
 * Existing-spec indexer — scans a repo for test files and classifies
 * them by the route / filling they cover.
 *
 * Design notes (Phase A.1 §7, roadmap-v2-agent-native.md):
 *   - Runs in-memory. Not persisted to disk. Context builder invokes
 *     it once per MCP call.
 *   - Shallow AST only — we read leading comments and import lines.
 *     ts-morph is not required here; regex is sufficient for the two
 *     coverage signals we care about.
 *   - Two classification signals:
 *       (a) `// @ate-covers: <id>` comment anywhere in the file
 *       (b) static import referencing `.../app/<path>/route` or
 *           `.../app/<path>/page` — the path is resolved to a route id.
 *   - Ate-generated files live under `tests/e2e/auto/`. Kind defaults
 *     to "user-written" otherwise.
 *   - `.mandu/ate-last-run.json` is read opportunistically — when
 *     present, each spec gets a `lastRun` timestamp + `status`. This
 *     unblocks the `existingSpecs` field in the MCP context blob
 *     without requiring a test run on every context lookup.
 */
import fg from "fast-glob";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { routeIdFromPath } from "./extractor-utils";

export type SpecKind = "user-written" | "ate-generated";

export interface SpecCoverage {
  /** Route id or filling id the spec targets (as declared or resolved). */
  coversRouteId: string | null;
  /** Raw coverage targets — first element becomes `coversRouteId`. */
  covers: string[];
  /** Concrete path (relative to repoRoot) of the resolved route file, if any. */
  coversFile: string | null;
}

export interface IndexedSpec {
  /** Repo-relative POSIX path. */
  path: string;
  kind: SpecKind;
  coverage: SpecCoverage;
  /** ISO timestamp of the last known run, if `.mandu/ate-last-run.json` has it. */
  lastRun: string | null;
  /** Pass / fail / skipped from the last run, if available. */
  status: "pass" | "fail" | "skipped" | null;
}

export interface SpecIndex {
  specs: IndexedSpec[];
  /** Number of files scanned. Useful for sanity checks in tests. */
  scanned: number;
}

const DEFAULT_SPEC_GLOBS = [
  "tests/**/*.spec.ts",
  "tests/**/*.spec.tsx",
  "tests/**/*.test.ts",
  "tests/**/*.test.tsx",
  "packages/**/tests/**/*.test.ts",
];

const AUTO_DIR_PATTERN = /tests[\\/]e2e[\\/]auto[\\/]/;

interface LastRunRecord {
  [specPathRelative: string]: {
    status: "pass" | "fail" | "skipped";
    lastRun: string;
  };
}

/**
 * Index all spec files in the repo. Returns an in-memory snapshot —
 * callers should treat it as request-scoped.
 */
export function indexSpecs(repoRoot: string, options: { globs?: string[] } = {}): SpecIndex {
  const globs = options.globs?.length ? options.globs : DEFAULT_SPEC_GLOBS;
  let files: string[] = [];
  try {
    files = fg.sync(globs, {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.mandu/**", "**/dist/**"],
    });
  } catch {
    return { specs: [], scanned: 0 };
  }

  const lastRun = readLastRunRecord(repoRoot);

  const specs: IndexedSpec[] = [];
  for (const abs of files) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    let source = "";
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    const kind: SpecKind = AUTO_DIR_PATTERN.test(rel) ? "ate-generated" : "user-written";
    const coverage = resolveCoverage(source, abs, repoRoot);

    const runEntry = lastRun[rel];
    specs.push({
      path: rel,
      kind,
      coverage,
      lastRun: runEntry?.lastRun ?? null,
      status: runEntry?.status ?? null,
    });
  }

  return { specs, scanned: files.length };
}

/**
 * Resolve which route/filling a spec covers.
 *
 * Priority:
 *   1. `// @ate-covers: <id>` comment(s). Multiple ids allowed (comma or
 *      newline separated). First id wins for the primary `coversRouteId`.
 *   2. Static import ending in `.../app/<path>/route` or
 *      `.../app/<path>/page` — resolved via the import specifier's
 *      relative path to a route id.
 *   3. Fallback: null.
 */
function resolveCoverage(source: string, specAbs: string, repoRoot: string): SpecCoverage {
  const covers: string[] = [];
  let coversFile: string | null = null;

  // 1. @ate-covers comments
  const commentRegex = /@ate-covers\s*:\s*([^\n*]+)/g;
  let m: RegExpExecArray | null;
  while ((m = commentRegex.exec(source)) !== null) {
    const raw = m[1].trim();
    for (const id of raw.split(/[\s,]+/).filter(Boolean)) {
      covers.push(id);
    }
  }

  // 2. Import resolution — scan static imports for route/page modules
  const importRegex = /import\s+[^'"]*?['"]([^'"]+)['"]/g;
  while ((m = importRegex.exec(source)) !== null) {
    const specifier = m[1];
    if (!specifier.startsWith(".")) continue;
    if (!/\/(route|page|route\.ts|page\.tsx|route\.tsx|page\.ts)$/.test(specifier)) {
      continue;
    }
    const specDir = dirname(specAbs);
    const abs = resolve(specDir, specifier);
    // The extractor writes route paths relative to `app/` or `routes/`;
    // convert the absolute path into the same format.
    const relToRoot = relative(repoRoot, abs).replace(/\\/g, "/");
    const routePath = relToRoot
      .replace(/^app\//, "/")
      .replace(/^routes\//, "/")
      .replace(/\/route(\.tsx?)?$/, "")
      .replace(/\/page(\.tsx?)?$/, "")
      .replace(/\/$/, "");
    const resolvedPath = routePath === "" ? "/" : routePath;
    const id = routeIdFromPath(resolvedPath);
    if (!covers.includes(id)) covers.push(id);

    // Preserve the resolved file path so context callers can show a
    // link back to the handler. We pick the first resolved file.
    if (!coversFile) {
      const fileRel = relative(repoRoot, abs).replace(/\\/g, "/");
      // Append the likely extension if the import specifier omitted it.
      if (/\.(ts|tsx)$/.test(fileRel)) {
        coversFile = fileRel;
      } else if (existsSync(`${abs}.ts`)) {
        coversFile = `${fileRel}.ts`;
      } else if (existsSync(`${abs}.tsx`)) {
        coversFile = `${fileRel}.tsx`;
      } else {
        coversFile = fileRel;
      }
    }
  }

  return {
    covers,
    coversRouteId: covers[0] ?? null,
    coversFile,
  };
}

/**
 * Load `.mandu/ate-last-run.json` if it exists. Expected shape:
 *
 *   {
 *     "tests/e2e/signup.spec.ts": { "status": "pass", "lastRun": "2026-04-20T..." }
 *   }
 *
 * Unknown shapes return an empty map. We deliberately do NOT enforce
 * a strict schema — the file is written by the ATE runner and read
 * here as a hint, not as a source of truth.
 */
function readLastRunRecord(repoRoot: string): LastRunRecord {
  const path = join(repoRoot, ".mandu", "ate-last-run.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LastRunRecord;
    }
  } catch {
    // Corrupt file — treat as absent.
  }
  return {};
}

/**
 * Filter an index to specs covering a given route id. Used by the
 * context builder when scope is "route" or "filling".
 */
export function specsForRouteId(index: SpecIndex, routeId: string): IndexedSpec[] {
  return index.specs.filter((spec) => spec.coverage.covers.includes(routeId));
}

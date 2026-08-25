import fs from "node:fs/promises";
import path from "node:path";
import { Glob } from "bun";
import ts from "typescript";

type DependencyBlock = Record<string, string>;

interface PackageManifest {
  name?: string;
  version?: string;
  workspaces?: string[] | {
    packages?: string[];
    catalog?: DependencyBlock;
    catalogs?: Record<string, DependencyBlock>;
  };
  dependencies?: DependencyBlock;
  devDependencies?: DependencyBlock;
  peerDependencies?: DependencyBlock;
  optionalDependencies?: DependencyBlock;
}

interface LockWorkspace extends PackageManifest {}

interface BunTextLock {
  lockfileVersion?: number;
  workspaces?: Record<string, LockWorkspace>;
  catalog?: DependencyBlock;
  catalogs?: Record<string, DependencyBlock>;
}

const DEPENDENCY_BLOCKS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function stableRecord(value: DependencyBlock | undefined): DependencyBlock {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function recordsEqual(a: DependencyBlock | undefined, b: DependencyBlock | undefined): boolean {
  return JSON.stringify(stableRecord(a)) === JSON.stringify(stableRecord(b));
}

async function readManifest(file: string): Promise<PackageManifest> {
  return JSON.parse(await fs.readFile(file, "utf8")) as PackageManifest;
}

function workspacePatterns(root: PackageManifest): string[] {
  if (Array.isArray(root.workspaces)) return root.workspaces;
  return root.workspaces?.packages ?? [];
}

async function collectWorkspaceManifests(
  rootDir: string,
  rootManifest: PackageManifest,
): Promise<Map<string, PackageManifest>> {
  const manifests = new Map<string, PackageManifest>([["", rootManifest]]);
  for (const rawPattern of workspacePatterns(rootManifest)) {
    const pattern = `${normalizePath(rawPattern)}/package.json`;
    const glob = new Glob(pattern);
    for await (const relativeFile of glob.scan({ cwd: rootDir, onlyFiles: true })) {
      const key = normalizePath(path.dirname(relativeFile));
      manifests.set(key, await readManifest(path.join(rootDir, relativeFile)));
    }
  }
  return manifests;
}

function parseLockfile(file: string, source: string): BunTextLock {
  const parsed = ts.parseConfigFileTextToJson(file, source);
  if (parsed.error) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  }
  return parsed.config as BunTextLock;
}

export async function collectBunLockConsistencyIssues(rootDir: string): Promise<string[]> {
  const root = path.resolve(rootDir);
  const rootManifest = await readManifest(path.join(root, "package.json"));
  const lockPath = path.join(root, "bun.lock");
  const lock = parseLockfile(lockPath, await fs.readFile(lockPath, "utf8"));
  const issues: string[] = [];

  if (lock.lockfileVersion !== 1) {
    issues.push(`bun.lock: expected lockfileVersion 1, received ${String(lock.lockfileVersion)}`);
  }

  const expected = await collectWorkspaceManifests(root, rootManifest);
  const actual = new Map(
    Object.entries(lock.workspaces ?? {}).map(([key, value]) => [normalizePath(key), value]),
  );

  for (const [key, manifest] of expected) {
    const label = key || "<root>";
    const locked = actual.get(key);
    if (!locked) {
      issues.push(`${label}: workspace is missing from bun.lock`);
      continue;
    }
    if (manifest.name !== locked.name) {
      issues.push(`${label}: package name differs from bun.lock`);
    }
    if (key && manifest.version !== locked.version) {
      issues.push(`${label}: package version differs from bun.lock`);
    }
    for (const block of DEPENDENCY_BLOCKS) {
      if (!recordsEqual(manifest[block], locked[block])) {
        issues.push(`${label}: ${block} differs from bun.lock`);
      }
    }
  }

  for (const key of actual.keys()) {
    if (!expected.has(key)) {
      issues.push(`${key || "<root>"}: stale workspace remains in bun.lock`);
    }
  }

  const rootWorkspaceConfig = Array.isArray(rootManifest.workspaces)
    ? undefined
    : rootManifest.workspaces;
  if (!recordsEqual(rootWorkspaceConfig?.catalog, lock.catalog)) {
    issues.push("workspace catalog differs from bun.lock");
  }
  const expectedCatalogs = rootWorkspaceConfig?.catalogs ?? {};
  const actualCatalogs = lock.catalogs ?? {};
  if (JSON.stringify(expectedCatalogs) !== JSON.stringify(actualCatalogs)) {
    issues.push("workspace named catalogs differ from bun.lock");
  }

  return issues;
}

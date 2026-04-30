#!/usr/bin/env bun
/**
 * Pre-publish check: workspace 의존성이 올바르게 해결되었는지 확인
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import * as fs from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

interface PackageJson {
  name: string;
  version: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const PUBLISHABLE_PACKAGE_DIRS = [
  "packages/core",
  "packages/ate",
  "packages/skills",
  "packages/mcp",
  "packages/cli",
  "packages/edge",
];

function dependencyBlocks(pkg: PackageJson): Array<[string, Record<string, string> | undefined]> {
  return [
    ["dependencies", pkg.dependencies],
    ["devDependencies", pkg.devDependencies],
    ["peerDependencies", pkg.peerDependencies],
    ["optionalDependencies", pkg.optionalDependencies],
  ];
}

function loadVersionMap(packageDirs: string[]): Map<string, string> {
  const versions = new Map<string, string>();
  for (const pkgDir of packageDirs) {
    const pkg: PackageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), pkgDir, "package.json"), "utf-8")
    );
    versions.set(pkg.name, pkg.version);
  }
  return versions;
}

function isAcceptableInternalSourceSpec(blockName: string, spec: string, version: string): boolean {
  if (blockName === "peerDependencies") {
    return !spec.startsWith("catalog:");
  }
  return spec.startsWith("workspace:") || spec === version || spec === `^${version}`;
}

function checkPackage(
  pkgPath: string,
  versionMap: Map<string, string>
): { name: string; issues: string[]; ok: string[] } {
  const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const issues: string[] = [];
  const ok: string[] = [];

  for (const [blockName, deps] of dependencyBlocks(pkg)) {
    if (!deps) continue;
    for (const [dep, spec] of Object.entries(deps)) {
      const workspaceVersion = versionMap.get(dep);
      if (!workspaceVersion) continue;

      if (isAcceptableInternalSourceSpec(blockName, spec, workspaceVersion)) {
        ok.push(`✅ ${blockName}.${dep}: ${spec}`);
      } else {
        issues.push(
          `❌ ${blockName}.${dep}: ${spec} (expected workspace:* or ${workspaceVersion}/^${workspaceVersion})`
        );
      }
    }
  }

  return { name: pkg.name, issues, ok };
}

function collectExportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectExportTargets);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectExportTargets);
  }
  return [];
}

function checkExportMap(pkgDir: string): { name: string; issues: string[]; ok: string[] } {
  const pkgPath = resolve(pkgDir, "package.json");
  const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const issues: string[] = [];
  const ok: string[] = [];

  if (!pkg.exports) {
    return { name: pkg.name, issues, ok };
  }

  if (pkg.name === "@mandujs/core" && Object.hasOwn(pkg.exports, "./*")) {
    issues.push("❌ exports./*: wildcard export makes every src file public");
  }

  for (const [subpath, target] of Object.entries(pkg.exports)) {
    for (const rawTarget of collectExportTargets(target)) {
      if (!rawTarget.startsWith(".") || rawTarget.includes("*")) continue;
      const targetPath = resolve(pkgDir, rawTarget);
      if (!existsSync(targetPath)) {
        issues.push(`❌ exports.${subpath}: target does not exist (${rawTarget})`);
      }
    }
  }

  if (issues.length === 0) {
    ok.push("✅ exports: explicit targets exist");
  }

  return { name: pkg.name, issues, ok };
}

async function resolveWorkspaceDepsForPack(
  pkgDir: string,
  versionMap: Map<string, string>
): Promise<string | null> {
  const filePath = join(pkgDir, "package.json");
  const original = await fs.readFile(filePath, "utf-8");
  const pkg: PackageJson = JSON.parse(original);
  let changed = false;

  for (const [, deps] of dependencyBlocks(pkg)) {
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!spec.startsWith("workspace:")) continue;
      const version = versionMap.get(name);
      if (!version) continue;
      deps[name] = `^${version}`;
      changed = true;
    }
  }

  if (!changed) return null;

  await fs.writeFile(filePath, JSON.stringify(pkg, null, 2) + "\n");
  return original;
}

/**
 * Stage a tarball via `bun pm pack` and assert the extracted package.json
 * contains no unsubstituted `workspace:` / `catalog:` specifiers or stale
 * internal @mandujs versions.
 *
 * Runs serially per package. When a source package uses `workspace:*`, this
 * mirrors `scripts/publish.ts` by resolving it before packing and restoring
 * the original package.json in a finally block.
 */
async function assertPackedPackageJson(
  pkgDir: string,
  versionMap: Map<string, string>
): Promise<string[]> {
  const issues: string[] = [];
  const tmp = await fs.mkdtemp(join(tmpdir(), "mandu-publish-check-"));
  let originalPackageJson: string | null = null;

  try {
    originalPackageJson = await resolveWorkspaceDepsForPack(pkgDir, versionMap);

    execSync(`bun pm pack --destination "${tmp}"`, {
      cwd: pkgDir,
      stdio: "pipe",
    });

    const entries = await fs.readdir(tmp);
    const tarball = entries.find((entry) => entry.endsWith(".tgz"));
    if (!tarball) {
      issues.push(`❌ ${pkgDir}: bun pm pack produced no tarball`);
      return issues;
    }

    // Use bsdtar on Windows (System32\tar.exe) which handles drive letters;
    // msys tar (/usr/bin/tar) treats "C:" as a remote host spec and fails.
    const tarCmd = process.platform === "win32"
      ? `"${join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")}" -xzf "${join(tmp, tarball)}" -C "${tmp}"`
      : `tar -xzf "${join(tmp, tarball)}" -C "${tmp}"`;
    execSync(tarCmd, { stdio: "pipe" });

    const stagedPkgPath = join(tmp, "package", "package.json");
    const staged = await fs.readFile(stagedPkgPath, "utf-8");
    const parsed: PackageJson = JSON.parse(staged);

    for (const [blockName, block] of dependencyBlocks(parsed)) {
      if (!block) continue;
      for (const [name, spec] of Object.entries(block)) {
        if (spec.startsWith("catalog:")) {
          issues.push(`❌ ${parsed.name}: ${blockName}.${name}@${spec} (catalog ref leaked into tarball!)`);
        }
        if (spec.startsWith("workspace:")) {
          issues.push(`❌ ${parsed.name}: ${blockName}.${name}@${spec} (workspace ref leaked into tarball!)`);
        }

        const expectedVersion = versionMap.get(name);
        if (
          expectedVersion &&
          blockName !== "peerDependencies" &&
          spec !== expectedVersion &&
          spec !== `^${expectedVersion}`
        ) {
          issues.push(
            `❌ ${parsed.name}: ${blockName}.${name}@${spec} (expected ${expectedVersion} or ^${expectedVersion})`
          );
        }
      }
    }

    if (issues.length === 0) {
      console.log(`  ✅ ${parsed.name} tarball: no leaked/stale internal specifiers`);
    }
  } finally {
    if (originalPackageJson !== null) {
      await fs.writeFile(join(pkgDir, "package.json"), originalPackageJson);
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }

  return issues;
}

console.log("🔍 Pre-publish check: workspace 의존성 검증\n");

// 1. lockfile 업데이트 확인
console.log("📦 Step 1: Lockfile 업데이트 확인...");
try {
  const lockfiles = ["bun.lock", "bun.lockb"].filter((file) =>
    existsSync(resolve(process.cwd(), file))
  );
  const status = lockfiles.length > 0
    ? execSync(`git status --porcelain -- ${lockfiles.join(" ")}`, { encoding: "utf-8" })
    : "";

  if (status.trim()) {
    console.log("⚠️  lockfile이 변경되었습니다. 커밋하시겠습니까?");
  } else {
    console.log("✅ Lockfile up-to-date\n");
  }
} catch {
  console.log("✅ Lockfile up-to-date\n");
}

// 2. workspace 의존성 검증
console.log("🔗 Step 2: Workspace 의존성 검증...\n");

const versions = loadVersionMap(PUBLISHABLE_PACKAGE_DIRS);
let hasIssues = false;

for (const pkgDir of PUBLISHABLE_PACKAGE_DIRS) {
  const pkgPath = resolve(process.cwd(), pkgDir, "package.json");
  try {
    const { name, issues, ok } = checkPackage(pkgPath, versions);
    console.log(`📦 ${name}`);
    ok.forEach((line) => console.log(`  ${line}`));

    if (issues.length > 0) {
      hasIssues = true;
      issues.forEach((issue) => console.log(`  ${issue}`));
    }

    const exportCheck = checkExportMap(resolve(process.cwd(), pkgDir));
    exportCheck.ok.forEach((line) => console.log(`  ${line}`));
    if (exportCheck.issues.length > 0) {
      hasIssues = true;
      exportCheck.issues.forEach((issue) => console.log(`  ${issue}`));
    }
    console.log();
  } catch (err: unknown) {
    console.error(`❌ Error reading ${pkgPath}:`, err instanceof Error ? err.message : String(err));
    hasIssues = true;
  }
}

// 3. 스테이지된 tarball 검증 (catalog:/workspace: 누설 방지)
console.log("📦 Step 3: 스테이지된 tarball 검증...\n");

for (const pkgDir of PUBLISHABLE_PACKAGE_DIRS) {
  const abs = resolve(process.cwd(), pkgDir);
  try {
    const leakIssues = await assertPackedPackageJson(abs, versions);
    if (leakIssues.length > 0) {
      hasIssues = true;
      leakIssues.forEach((issue) => console.log(`  ${issue}`));
    }
  } catch (err) {
    hasIssues = true;
    console.error(`❌ Tarball check failed for ${pkgDir}:`, err instanceof Error ? err.message : String(err));
  }
}
console.log();

// 4. 버전 일관성 검증
console.log("🔢 Step 4: 버전 일관성 검증...\n");

for (const pkgDir of PUBLISHABLE_PACKAGE_DIRS) {
  const pkg: PackageJson = JSON.parse(
    readFileSync(resolve(process.cwd(), pkgDir, "package.json"), "utf-8")
  );
  console.log(`  ${pkg.name}: ${pkg.version}`);
}

console.log();

// 최종 결과
if (hasIssues) {
  console.error("❌ Pre-publish check FAILED!");
  console.error("\n💡 Fix:");
  console.error("   1. Run: bun install");
  console.error("   2. Commit updated bun.lock");
  console.error("   3. Re-run publish");
  process.exit(1);
} else {
  console.log("✅ Pre-publish check PASSED!");
  console.log("\n✨ Ready to publish!\n");
}

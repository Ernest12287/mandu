/**
 * Resource Generator
 * Main orchestrator for generating resource artifacts
 *
 * Phase 4c extension: when a resource declares `options.persistence`, the
 * orchestrator also emits a typed repo module (`*.repo.ts`) alongside the
 * existing contract/types/slot/client artifacts. See `generator-repo.ts`
 * for emission details; schema + migration generation is app-level and
 * handled by `generateSchemaArtifacts` (separate entry point called by
 * the CLI's `mandu db plan`).
 */

import type { ParsedResource } from "./parser";
import type { ResourceDefinition } from "./schema";
import { generateResourceContract } from "./generators/contract";
import { generateResourceTypes } from "./generators/types";
import { generateResourceSlot } from "./generators/slot";
import { generateResourceClient } from "./generators/client";
import { generateRepoSource, shouldEmitRepo } from "./generator-repo";
import {
  computeSchemaGeneration,
  writeSchemaArtifacts,
  type SchemaGenerationResult,
  type WriteSchemaArtifactsResult,
} from "./generator-schema";
import { resolveGeneratedPaths } from "../paths";
import type { SqlProvider } from "./ddl/types";
import path from "path";
import fs from "fs/promises";

// ============================================
// Generator Options
// ============================================

export interface GeneratorOptions {
  /** 프로젝트 루트 디렉토리 */
  rootDir: string;
  /** 기존 슬롯 덮어쓰기 (기본: false) */
  force?: boolean;
  /** 특정 파일만 생성 */
  only?: ("contract" | "types" | "slot" | "client" | "repo")[];
}

// ============================================
// Generator Result
// ============================================

export interface GeneratorResult {
  success: boolean;
  created: string[];
  skipped: string[];
  errors: string[];
  /**
   * Phase 4c — set when a repo was emitted for this resource. When the
   * resource has no `options.persistence`, this is `false` and no repo
   * file is written.
   */
  repoEmitted?: boolean;
}

// ============================================
// File Utilities
// ============================================

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch  {
    // Ignore if exists
  }
}

// ============================================
// Generate Resource Artifacts
// ============================================

/**
 * Generate all artifacts for a resource
 *
 * @param parsed - Parsed resource schema
 * @param options - Generator options
 * @returns Generation result
 *
 * @example
 * ```typescript
 * const parsed = await parseResourceSchema("/path/to/user.resource.ts");
 * const result = await generateResourceArtifacts(parsed, {
 *   rootDir: process.cwd(),
 *   force: false,
 * });
 * ```
 */
export async function generateResourceArtifacts(
  parsed: ParsedResource,
  options: GeneratorOptions
): Promise<GeneratorResult> {
  const result: GeneratorResult = {
    success: true,
    created: [],
    skipped: [],
    errors: [],
  };

  const { definition, resourceName } = parsed;
  const { rootDir, force = false, only } = options;

  const paths = resolveGeneratedPaths(rootDir);

  try {
    // 1. Generate Contract (always regenerate)
    if (!only || only.includes("contract")) {
      await generateContract(definition, resourceName, paths.resourceContractsDir, result);
    }

    // 2. Generate Types (always regenerate)
    if (!only || only.includes("types")) {
      await generateTypes(definition, resourceName, paths.resourceTypesDir, result);
    }

    // 3. Generate Slot (PRESERVE if exists unless --force)
    if (!only || only.includes("slot")) {
      await generateSlot(definition, resourceName, paths.resourceSlotsDir, force, result);
    }

    // 4. Generate Client (always regenerate)
    if (!only || only.includes("client")) {
      await generateClient(definition, resourceName, paths.resourceClientDir, result);
    }

    // 5. Phase 4c — Generate Repo (only when persistence is declared, always regenerate)
    if ((!only || only.includes("repo")) && shouldEmitRepo(parsed)) {
      await generateRepo(parsed, paths.resourceReposDir, result);
    }
  } catch (error) {
    result.success = false;
    result.errors.push(
      `Failed to generate resource "${resourceName}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return result;
}

/**
 * Generate contract file
 */
async function generateContract(
  definition: ResourceDefinition,
  resourceName: string,
  contractsDir: string,
  result: GeneratorResult
): Promise<void> {
  await ensureDir(contractsDir);

  const contractPath = path.join(contractsDir, `${resourceName}.contract.ts`);
  const contractContent = generateResourceContract(definition);

  await Bun.write(contractPath, contractContent);
  result.created.push(contractPath);
}

/**
 * Generate types file
 */
async function generateTypes(
  definition: ResourceDefinition,
  resourceName: string,
  typesDir: string,
  result: GeneratorResult
): Promise<void> {
  await ensureDir(typesDir);

  const typesPath = path.join(typesDir, `${resourceName}.types.ts`);
  const typesContent = generateResourceTypes(definition);

  await Bun.write(typesPath, typesContent);
  result.created.push(typesPath);
}

/**
 * Generate slot file (PRESERVE if exists!)
 */
async function generateSlot(
  definition: ResourceDefinition,
  resourceName: string,
  slotsDir: string,
  force: boolean,
  result: GeneratorResult
): Promise<void> {
  await ensureDir(slotsDir);

  const slotPath = path.join(slotsDir, `${resourceName}.slot.ts`);
  const slotExists = await fileExists(slotPath);

  // CRITICAL: Slot preservation logic
  if (!slotExists || force) {
    const slotContent = generateResourceSlot(definition);
    await Bun.write(slotPath, slotContent);
    result.created.push(slotPath);

    if (slotExists && force) {
      console.log(`⚠️  Overwriting existing slot (--force): ${slotPath}`);
    }
  } else {
    result.skipped.push(slotPath);
    console.log(`✓ Preserving existing slot: ${slotPath}`);
  }
}

/**
 * Generate client file
 */
async function generateClient(
  definition: ResourceDefinition,
  resourceName: string,
  clientDir: string,
  result: GeneratorResult
): Promise<void> {
  await ensureDir(clientDir);

  const clientPath = path.join(clientDir, `${resourceName}.client.ts`);
  const clientContent = generateResourceClient(definition);

  await Bun.write(clientPath, clientContent);
  result.created.push(clientPath);
}

/**
 * Phase 4c — Generate repo file.
 *
 * Always regenerate (derived). Caller is expected to have already checked
 * `shouldEmitRepo(parsed)` to avoid emitting repos for non-persistent
 * resources. We double-check here because `generateRepoSource` throws on
 * non-persistent resources by default.
 */
async function generateRepo(
  parsed: ParsedResource,
  reposDir: string,
  result: GeneratorResult
): Promise<void> {
  await ensureDir(reposDir);

  const repoContent = generateRepoSource(parsed, { enable: false });
  if (repoContent === null) {
    // Non-persistent resource — caller should have filtered this out but
    // we handle it gracefully.
    return;
  }

  const repoPath = path.join(reposDir, `${parsed.definition.name}.repo.ts`);
  await Bun.write(repoPath, repoContent);
  result.created.push(repoPath);
  result.repoEmitted = true;
}

// ============================================
// Batch Generation
// ============================================

/**
 * Generate artifacts for multiple resources
 *
 * @param resources - Array of parsed resources
 * @param options - Generator options
 * @returns Combined generation result
 */
export async function generateResourcesArtifacts(
  resources: ParsedResource[],
  options: GeneratorOptions
): Promise<GeneratorResult> {
  const combinedResult: GeneratorResult = {
    success: true,
    created: [],
    skipped: [],
    errors: [],
  };

  for (const resource of resources) {
    const result = await generateResourceArtifacts(resource, options);

    combinedResult.created.push(...result.created);
    combinedResult.skipped.push(...result.skipped);
    combinedResult.errors.push(...result.errors);

    if (!result.success) {
      combinedResult.success = false;
    }
  }

  return combinedResult;
}

// ============================================
// Phase 4c — App-level schema + migration orchestration
// ============================================

/**
 * Options for `generateSchemaArtifacts`. All fields optional.
 */
export interface SchemaArtifactsOptions {
  /**
   * Project root. Required.
   */
  rootDir: string;
  /**
   * Provider override. When omitted, the provider is derived from the
   * resources' persistence blocks. Pass this to generate DDL for a
   * different target than what's declared in the resources (useful for
   * CLI flags like `mandu db plan --provider sqlite`).
   */
  provider?: SqlProvider;
  /**
   * Dry-run mode: compute the diff + SQL but DO NOT write any files.
   * The caller inspects the returned result and decides whether to persist.
   */
  dryRun?: boolean;
}

/**
 * The combined result of an app-level schema generation pass.
 */
export interface SchemaArtifactsResult {
  /** The computed diff / desired SQL / preview filename. */
  generation: SchemaGenerationResult;
  /** The actual write result, or `null` when `dryRun: true`. */
  write: WriteSchemaArtifactsResult | null;
}

/**
 * Run the schema + migration generation step for an entire project.
 *
 * This is distinct from `generateResourceArtifacts` which handles
 * per-resource contract/slot/types/client/repo emission. Schema + migration
 * are project-level because a single migration file aggregates changes
 * across ALL persistent resources.
 *
 * Typical caller: `mandu db plan` in the CLI (Agent E).
 *
 * @returns The computed generation result and (unless `dryRun: true`)
 *   the write result describing which files were created on disk.
 */
export async function generateSchemaArtifacts(
  resources: ParsedResource[],
  options: SchemaArtifactsOptions,
): Promise<SchemaArtifactsResult> {
  const { rootDir, provider, dryRun = false } = options;
  const generation = await computeSchemaGeneration(resources, rootDir, provider);
  if (dryRun) {
    return { generation, write: null };
  }
  const write = await writeSchemaArtifacts(generation, rootDir);
  return { generation, write };
}

// ============================================
// Summary Logging
// ============================================

/**
 * Log generation result summary
 */
export function logGeneratorResult(result: GeneratorResult): void {
  console.log("\n📦 Resource Generation Summary:");
  console.log(`  ✅ Created: ${result.created.length} files`);
  console.log(`  ⏭️  Skipped: ${result.skipped.length} files`);

  if (result.errors.length > 0) {
    console.log(`  ❌ Errors: ${result.errors.length}`);
    result.errors.forEach((error) => console.error(`    - ${error}`));
  }

  if (result.created.length > 0) {
    console.log("\n  Created files:");
    result.created.forEach((file) => console.log(`    - ${file}`));
  }

  if (result.skipped.length > 0) {
    console.log("\n  Skipped (preserved):");
    result.skipped.forEach((file) => console.log(`    - ${file}`));
  }

  console.log();
}

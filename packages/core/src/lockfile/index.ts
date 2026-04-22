/**
 * Mandu Lockfile I/O 📁
 *
 * Lockfile 읽기/쓰기 및 공개 API
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type ManduLockfile,
  type LockfileError,
  LOCKFILE_PATH,
  LOCKFILE_DIR,
  LOCKFILE_SCHEMA_VERSION,
} from "./types.js";

// ============================================
// 읽기
// ============================================

/**
 * Lockfile 읽기
 *
 * @param projectRoot 프로젝트 루트 디렉토리
 * @returns Lockfile 또는 null (없는 경우)
 * @throws 파싱 오류 시
 *
 * @example
 * ```typescript
 * const lockfile = await readLockfile(process.cwd());
 * if (lockfile) {
 *   console.log(`Config hash: ${lockfile.configHash}`);
 * }
 * ```
 */
export async function readLockfile(
  projectRoot: string
): Promise<ManduLockfile | null> {
  const lockfilePath = path.join(projectRoot, LOCKFILE_PATH);

  try {
    const file = Bun.file(lockfilePath);
    const exists = await file.exists();

    if (!exists) {
      return null;
    }

    const content = await file.text();
    const data = JSON.parse(content) as ManduLockfile;

    // 스키마 버전 체크
    if (data.schemaVersion !== LOCKFILE_SCHEMA_VERSION) {
      console.warn(
        `[Mandu] Lockfile schema version mismatch: expected ${LOCKFILE_SCHEMA_VERSION}, got ${data.schemaVersion}`
      );
    }

    return data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Failed to parse lockfile at ${lockfilePath}: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

/**
 * MCP 설정 읽기 (.mcp.json)
 */
export async function readMcpConfig(
  projectRoot: string
): Promise<Record<string, unknown> | null> {
  const mcpPath = path.join(projectRoot, ".mcp.json");

  try {
    const file = Bun.file(mcpPath);
    const exists = await file.exists();
    if (!exists) return null;

    const content = await file.text();
    const data = JSON.parse(content) as Record<string, unknown>;
    return data ?? null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse .mcp.json at ${mcpPath}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Lockfile 존재 여부 확인
 */
export async function lockfileExists(projectRoot: string): Promise<boolean> {
  const lockfilePath = path.join(projectRoot, LOCKFILE_PATH);
  const file = Bun.file(lockfilePath);
  return file.exists();
}

// ============================================
// 쓰기
// ============================================

/**
 * Lockfile 쓰기
 *
 * @param projectRoot 프로젝트 루트 디렉토리
 * @param lockfile Lockfile 데이터
 *
 * @example
 * ```typescript
 * const lockfile = generateLockfile(config);
 * await writeLockfile(process.cwd(), lockfile);
 * ```
 */
export async function writeLockfile(
  projectRoot: string,
  lockfile: ManduLockfile
): Promise<void> {
  const lockfileDir = path.join(projectRoot, LOCKFILE_DIR);
  const lockfilePath = path.join(projectRoot, LOCKFILE_PATH);

  // 디렉토리 생성
  await mkdir(lockfileDir, { recursive: true });

  // JSON 포맷팅 (가독성)
  const content = JSON.stringify(lockfile, null, 2);

  // 쓰기
  await Bun.write(lockfilePath, content);
}

/**
 * Lockfile 삭제
 */
export async function deleteLockfile(projectRoot: string): Promise<boolean> {
  const lockfilePath = path.join(projectRoot, LOCKFILE_PATH);

  try {
    const file = Bun.file(lockfilePath);
    const exists = await file.exists();

    if (!exists) {
      return false;
    }

    const { unlink } = await import("node:fs/promises");
    await unlink(lockfilePath);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// 유틸리티
// ============================================

/**
 * Lockfile 경로 가져오기
 */
export function getLockfilePath(projectRoot: string): string {
  return path.join(projectRoot, LOCKFILE_PATH);
}

/**
 * Lockfile 오류 생성 헬퍼
 */
export function createLockfileError(
  code: LockfileError["code"],
  message: string,
  details?: Record<string, unknown>
): LockfileError {
  return { code, message, details };
}

// ============================================
// Re-exports
// ============================================

export * from "./types.js";
export * from "./generate.js";
export * from "./validate.js";

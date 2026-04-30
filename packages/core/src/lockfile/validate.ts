/**
 * Mandu Lockfile 검증 ✅
 *
 * Lockfile과 현재 설정의 일치 여부 검증
 */

import { diffConfig } from "../utils/differ.js";
import { computeCurrentHashes, resolveMcpSources } from "./generate.js";
import {
  type ManduLockfile,
  type LockfileValidationResult,
  type LockfileError,
  type LockfileWarning,
  type LockfileMode,
  DEFAULT_POLICIES,
  LOCKFILE_SCHEMA_VERSION,
  BYPASS_ENV_VAR,
} from "./types.js";

// ============================================
// 검증
// ============================================

/**
 * Lockfile 검증
 *
 * @param config 현재 설정
 * @param lockfile Lockfile 데이터
 * @returns 검증 결과
 *
 * @example
 * ```typescript
 * const lockfile = await readLockfile(projectRoot);
 * if (lockfile) {
 *   const result = validateLockfile(config, lockfile);
 *   if (!result.valid) {
 *     console.error("Lockfile mismatch:", result.errors);
 *   }
 * }
 * ```
 */
export function validateLockfile(
  config: Record<string, unknown>,
  lockfile: ManduLockfile,
  mcpConfig?: Record<string, unknown> | null
): LockfileValidationResult {
  const errors: LockfileError[] = [];
  const warnings: LockfileWarning[] = [];

  // 현재 해시 계산
  const { configHash, mcpConfigHash } = computeCurrentHashes(config, mcpConfig);
  const { mcpServers } = resolveMcpSources(config, mcpConfig);

  // 1. 스키마 버전 체크
  if (lockfile.schemaVersion !== LOCKFILE_SCHEMA_VERSION) {
    warnings.push({
      code: "LOCKFILE_OUTDATED",
      message: `Lockfile schema version mismatch: expected ${LOCKFILE_SCHEMA_VERSION}, got ${lockfile.schemaVersion}`,
      details: {
        expected: LOCKFILE_SCHEMA_VERSION,
        actual: lockfile.schemaVersion,
      },
    });
  }

  // 2. 설정 해시 비교
  if (configHash !== lockfile.configHash) {
    errors.push({
      code: "CONFIG_HASH_MISMATCH",
      message: "Configuration has changed since lockfile was generated",
      details: {
        expected: lockfile.configHash,
        actual: configHash,
      },
    });
  }

  // 3. MCP 설정 해시 비교 (있는 경우)
  if (lockfile.mcpConfigHash && mcpConfigHash !== lockfile.mcpConfigHash) {
    errors.push({
      code: "MCP_CONFIG_HASH_MISMATCH",
      message: "MCP configuration has changed since lockfile was generated",
      details: {
        expected: lockfile.mcpConfigHash,
        actual: mcpConfigHash,
      },
    });
  }

  // 4. MCP 서버 변경 감지
  if (lockfile.mcpServers && mcpServers) {
    const lockedServers = new Set(Object.keys(lockfile.mcpServers));
    const currentServers = new Set(Object.keys(mcpServers));

    // 추가된 서버
    for (const server of currentServers) {
      if (!lockedServers.has(server)) {
        warnings.push({
          code: "MCP_SERVER_ADDED",
          message: `MCP server "${server}" was added`,
          details: { server },
        });
      }
    }

    // 삭제된 서버
    for (const server of lockedServers) {
      if (!currentServers.has(server)) {
        warnings.push({
          code: "MCP_SERVER_REMOVED",
          message: `MCP server "${server}" was removed`,
          details: { server },
        });
      }
    }
  }

  // 5. 스냅샷 누락 경고
  if (!lockfile.snapshot) {
    warnings.push({
      code: "SNAPSHOT_MISSING",
      message: "Lockfile does not include configuration snapshot",
    });
  }

  // 6. Diff 계산 (오류가 있는 경우에만)
  let diff;
  if (errors.length > 0 && lockfile.snapshot) {
    const configForDiff = mcpServers
      ? { ...config, mcpServers }
      : config;
    diff = diffConfig(lockfile.snapshot.config, configForDiff);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    diff,
    currentHash: configHash,
    lockedHash: lockfile.configHash,
  };
}

// ============================================
// 정책 기반 검증
// ============================================

/**
 * 환경 정책에 따른 검증 수행
 */
export function validateWithPolicy(
  config: Record<string, unknown>,
  lockfile: ManduLockfile | null,
  mode?: LockfileMode,
  mcpConfig?: Record<string, unknown> | null
): {
  result: LockfileValidationResult | null;
  action: "pass" | "warn" | "error" | "block";
  bypassed: boolean;
} {
  const resolvedMode = mode ?? detectMode();
  const policy = DEFAULT_POLICIES[resolvedMode];
  const bypassed = isBypassed();

  // Lockfile 없는 경우
  if (!lockfile) {
    const action = bypassed ? "warn" : policy.onMissing;
    return {
      result: null,
      action: action === "create" ? "warn" : action,
      bypassed,
    };
  }

  // 검증 수행
  const result = validateLockfile(config, lockfile, mcpConfig);

  // 통과
  if (result.valid) {
    return { result, action: "pass", bypassed };
  }

  // 불일치 시 정책 적용
  const action = bypassed ? "warn" : policy.onMismatch;
  return { result, action, bypassed };
}

/**
 * 현재 모드 감지
 */
export function detectMode(): LockfileMode {
  // CI 환경
  if (
    process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GITLAB_CI === "true"
  ) {
    return "ci";
  }

  // 빌드 모드 (npm run build 등)
  if (process.env.npm_lifecycle_event === "build") {
    return "build";
  }

  // 프로덕션
  if (process.env.NODE_ENV === "production") {
    return "production";
  }

  return "development";
}

/**
 * 우회 환경변수 체크
 */
export function isBypassed(): boolean {
  return process.env[BYPASS_ENV_VAR] === "1" || process.env[BYPASS_ENV_VAR] === "true";
}

// ============================================
// 빠른 검증
// ============================================

/**
 * 해시만 빠르게 비교
 */
export function quickValidate(
  config: Record<string, unknown>,
  lockfile: ManduLockfile,
  mcpConfig?: Record<string, unknown> | null
): boolean {
  const { configHash } = computeCurrentHashes(config, mcpConfig);
  return configHash === lockfile.configHash;
}

/**
 * Lockfile이 최신인지 확인
 */
export function isLockfileStale(
  config: Record<string, unknown>,
  lockfile: ManduLockfile,
  mcpConfig?: Record<string, unknown> | null
): boolean {
  return !quickValidate(config, lockfile, mcpConfig);
}

// ============================================
// 검증 결과 포맷팅
// ============================================

/**
 * 검증 결과를 콘솔 메시지로 변환
 */
export function formatValidationResult(
  result: LockfileValidationResult
): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push("✅ Lockfile 검증 통과");
    lines.push(`   해시: ${result.currentHash}`);
  } else {
    lines.push("❌ Lockfile 검증 실패");
    lines.push("");

    for (const error of result.errors) {
      lines.push(`   🔴 ${error.message}`);
      if (error.details) {
        lines.push(`      예상: ${error.details.expected}`);
        lines.push(`      실제: ${error.details.actual}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("   경고:");
    for (const warning of result.warnings) {
      lines.push(`   ⚠️  ${warning.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * 정책 액션에 따른 메시지 생성
 */
export function formatPolicyAction(
  action: "pass" | "warn" | "error" | "block",
  bypassed: boolean
): string {
  const bypassNote = bypassed ? " (우회됨)" : "";

  switch (action) {
    case "pass":
      return "✅ Lockfile 검증 통과";
    case "warn":
      return `⚠️  Lockfile 불일치 - 경고${bypassNote}`;
    case "error":
      return `❌ Lockfile 불일치 - 빌드 실패${bypassNote}`;
    case "block":
      return `🛑 Lockfile 불일치 - 서버 시작 차단${bypassNote}`;
  }
}

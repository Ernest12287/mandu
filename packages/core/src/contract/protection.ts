/**
 * Contract Protection - 보호 필드 시스템
 *
 * Symbol 메타데이터를 사용하여 Contract의 민감/보호 필드를 관리
 *
 * @see docs/plans/09_lockfile_integration_plan.md
 */

import { z } from "zod";
import {
  isSensitiveField,
  isProtectedField,
  getMetadata,
  PROTECTED_FIELD,
  SENSITIVE_FIELD,
  type ProtectedFieldMetadata,
  type SensitiveFieldMetadata,
} from "../config";

// ============================================
// 타입
// ============================================

export interface ProtectedFieldInfo {
  /** 필드 경로 (예: "body.password") */
  path: string;
  /** 보호 이유 */
  reason: string;
  /** 수정 허용 대상 */
  allowedModifiers: string[];
  /** 민감 필드 여부 */
  isSensitive: boolean;
}

export interface ProtectionViolation {
  /** 위반 필드 경로 */
  field: string;
  /** 보호 이유 */
  reason: string;
  /** 오류 메시지 */
  message: string;
  /** 수정자 */
  modifier: string;
}

export interface ContractChangeValidation {
  /** 유효 여부 */
  valid: boolean;
  /** 보호 위반 목록 */
  violations: ProtectionViolation[];
}

// ============================================
// 보호 필드 추출
// ============================================

/**
 * Zod 스키마에서 보호된 필드 목록 추출
 *
 * @param schema Zod 스키마
 * @param basePath 기본 경로 (재귀용)
 * @returns 보호된 필드 정보 목록
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   apiKey: sensitiveToken(),
 *   config: z.object({
 *     secret: protectedField("Security"),
 *   }),
 * });
 *
 * const fields = extractProtectedFields(schema);
 * // [
 * //   { path: "apiKey", reason: "Sensitive token...", ... },
 * //   { path: "config.secret", reason: "Security", ... },
 * // ]
 * ```
 */
export function extractProtectedFields(
  schema: z.ZodType,
  basePath = ""
): ProtectedFieldInfo[] {
  const fields: ProtectedFieldInfo[] = [];

  // ZodObject 처리
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;

    for (const [key, value] of Object.entries(shape)) {
      const currentPath = basePath ? `${basePath}.${key}` : key;

      // 보호된 필드 확인
      if (isProtectedField(value)) {
        const meta = getMetadata(value, PROTECTED_FIELD) as ProtectedFieldMetadata | undefined;
        fields.push({
          path: currentPath,
          reason: meta?.reason ?? "Protected field",
          allowedModifiers: meta?.allowedModifiers ?? ["human"],
          isSensitive: isSensitiveField(value),
        });
      }
      // 민감 필드도 보호 대상
      else if (isSensitiveField(value)) {
        const _meta = getMetadata(value, SENSITIVE_FIELD) as SensitiveFieldMetadata | undefined;
        fields.push({
          path: currentPath,
          reason: "Sensitive field - redacted in logs",
          allowedModifiers: ["human"],
          isSensitive: true,
        });
      }

      // 중첩 객체 재귀 탐색
      if (value instanceof z.ZodObject) {
        const nested = extractProtectedFields(value, currentPath);
        fields.push(...nested);
      }
      // Optional 처리
      else if (value instanceof z.ZodOptional) {
        const inner = value.unwrap();
        if (inner instanceof z.ZodObject) {
          const nested = extractProtectedFields(inner, currentPath);
          fields.push(...nested);
        }
      }
      // Nullable 처리
      else if (value instanceof z.ZodNullable) {
        const inner = value.unwrap();
        if (inner instanceof z.ZodObject) {
          const nested = extractProtectedFields(inner, currentPath);
          fields.push(...nested);
        }
      }
    }
  }

  return fields;
}

/**
 * Contract 스키마 전체에서 보호 필드 추출
 */
export function extractContractProtectedFields(
  contract: { request?: unknown; response?: unknown }
): {
  request: ProtectedFieldInfo[];
  response: ProtectedFieldInfo[];
} {
  const request: ProtectedFieldInfo[] = [];
  const response: ProtectedFieldInfo[] = [];

  // Request 스키마 탐색
  if (contract.request && typeof contract.request === "object") {
    for (const [method, schema] of Object.entries(contract.request)) {
      if (schema && typeof schema === "object") {
        const methodSchema = schema as Record<string, z.ZodType>;

        // body, query, params, headers
        for (const [part, partSchema] of Object.entries(methodSchema)) {
          if (partSchema instanceof z.ZodType) {
            const fields = extractProtectedFields(partSchema, `${method}.${part}`);
            request.push(...fields);
          }
        }
      }
    }
  }

  // Response 스키마 탐색
  if (contract.response && typeof contract.response === "object") {
    for (const [status, schema] of Object.entries(contract.response)) {
      if (schema instanceof z.ZodType) {
        const fields = extractProtectedFields(schema, `${status}`);
        response.push(...fields);
      }
    }
  }

  return { request, response };
}

// ============================================
// 변경 검증
// ============================================

/**
 * 객체에서 경로로 값 가져오기
 */
function _getValueByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Contract 변경 시 보호 필드 검증
 *
 * @param oldSchema 이전 스키마
 * @param newSchema 새 스키마
 * @param modifier 수정자 ("human" | "ai")
 * @returns 검증 결과
 *
 * @example
 * ```typescript
 * const validation = validateContractChanges(
 *   oldContract.request,
 *   newContract.request,
 *   "ai"
 * );
 *
 * if (!validation.valid) {
 *   console.error("AI가 보호된 필드를 수정하려고 합니다:", validation.violations);
 * }
 * ```
 */
export function validateContractChanges(
  oldSchema: z.ZodType,
  newSchema: z.ZodType,
  modifier: "human" | "ai"
): ContractChangeValidation {
  const violations: ProtectionViolation[] = [];

  // 이전 스키마에서 보호 필드 추출
  const protectedFields = extractProtectedFields(oldSchema);

  for (const field of protectedFields) {
    // 수정 권한 확인
    if (!field.allowedModifiers.includes(modifier)) {
      // 스키마 구조 변경 감지 (간단한 비교)
      const oldValue = getSchemaDefinition(oldSchema, field.path);
      const newValue = getSchemaDefinition(newSchema, field.path);

      // 구조가 변경되었는지 확인
      if (hasSchemaChanged(oldValue, newValue)) {
        violations.push({
          field: field.path,
          reason: field.reason,
          message: `${modifier}는 보호된 필드 '${field.path}'를 수정할 수 없습니다`,
          modifier,
        });
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * 스키마에서 경로로 정의 가져오기
 */
function getSchemaDefinition(schema: z.ZodType, path: string): z.ZodType | undefined {
  const parts = path.split(".");
  let current: z.ZodType | undefined = schema;

  for (const part of parts) {
    if (!current) return undefined;

    if (current instanceof z.ZodObject) {
      current = current.shape[part] as z.ZodType | undefined;
    } else if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      if (current instanceof z.ZodObject) {
        current = current.shape[part] as z.ZodType | undefined;
      }
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * 스키마가 변경되었는지 확인 (간단한 비교)
 */
function hasSchemaChanged(
  oldSchema: z.ZodType | undefined,
  newSchema: z.ZodType | undefined
): boolean {
  // 둘 다 없으면 변경 없음
  if (!oldSchema && !newSchema) return false;

  // 하나만 있으면 변경됨
  if (!oldSchema || !newSchema) return true;

  // 타입이 다르면 변경됨
  const oldTypeName = (oldSchema._def as { typeName?: string }).typeName;
  const newTypeName = (newSchema._def as { typeName?: string }).typeName;
  if (oldTypeName !== newTypeName) {
    return true;
  }

  // ZodObject의 경우 shape 키 비교
  if (oldSchema instanceof z.ZodObject && newSchema instanceof z.ZodObject) {
    const oldKeys = Object.keys(oldSchema.shape);
    const newKeys = Object.keys(newSchema.shape);

    if (oldKeys.length !== newKeys.length) return true;

    for (const key of oldKeys) {
      if (!newKeys.includes(key)) return true;
    }
  }

  return false;
}

// ============================================
// 포맷팅
// ============================================

/**
 * 보호 필드 목록을 문자열로 포맷
 */
export function formatProtectedFields(fields: ProtectedFieldInfo[]): string {
  if (fields.length === 0) {
    return "보호된 필드 없음";
  }

  const lines: string[] = ["보호된 필드:"];

  for (const field of fields) {
    const sensitive = field.isSensitive ? " 🔐" : "";
    lines.push(`  - ${field.path}${sensitive}`);
    lines.push(`    이유: ${field.reason}`);
    lines.push(`    수정 가능: ${field.allowedModifiers.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * 보호 위반 목록을 문자열로 포맷
 */
export function formatProtectionViolations(violations: ProtectionViolation[]): string {
  if (violations.length === 0) {
    return "위반 없음";
  }

  const lines: string[] = ["🛑 보호 필드 위반:"];

  for (const v of violations) {
    lines.push(`  - ${v.field}`);
    lines.push(`    ${v.message}`);
    lines.push(`    이유: ${v.reason}`);
  }

  return lines.join("\n");
}

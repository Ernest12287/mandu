/**
 * Mandu Self-Healing Guard
 *
 * 아키텍처 위반 자동 감지 및 수정 제안
 *
 * @module guard/healing
 *
 * @example
 * ```typescript
 * import { checkWithHealing } from "@mandujs/core/guard";
 *
 * const result = await checkWithHealing(config, rootDir);
 *
 * for (const item of result.items) {
 *   console.log(item.violation.message);
 *   console.log(item.healing.primary);
 *
 *   if (item.healing.autoFix) {
 *     await item.healing.autoFix(); // 자동 수정
 *   }
 * }
 * ```
 */

import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join, extname, resolve, normalize } from "path";
import type {
  Violation,
  ViolationType,
  GuardConfig,
  GuardPreset,
} from "./types";
import { getDocumentationLink } from "./suggestions";
import { checkDirectory } from "./watcher";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 자동 수정 옵션
 */
export interface HealingOption {
  /** 옵션 레이블 */
  label: string;

  /** 상세 설명 */
  explanation: string;

  /** 우선순위 (낮을수록 권장) */
  priority: number;

  /** 수정 전 코드 */
  before?: string;

  /** 수정 후 코드 */
  after?: string;

  /** 파일 이동이 필요한 경우 */
  moveFile?: {
    from: string;
    to: string;
  };

  /** 자동 수정 함수 */
  autoFix?: () => Promise<HealingFixResult>;
}

/**
 * 자동 수정 결과
 */
export interface HealingFixResult {
  /** 성공 여부 */
  success: boolean;

  /** 결과 메시지 */
  message: string;

  /** 변경된 파일들 */
  changedFiles?: string[];

  /** 에러 (실패 시) */
  error?: Error;
}

/**
 * Healing 제안
 */
export interface HealingSuggestion {
  /** 주요 해결책 */
  primary: HealingOption;

  /** 대안들 */
  alternatives: HealingOption[];

  /** 컨텍스트 정보 */
  context: HealingContext;
}

/**
 * Healing 컨텍스트
 */
export interface HealingContext {
  /** 레이어 계층 구조 */
  layerHierarchy: string;

  /** 적용된 규칙 */
  rule: string;

  /** 규칙 설명 */
  ruleDescription: string;

  /** 문서 링크 */
  documentation: string;

  /** 허용된 레이어들 */
  allowedLayers: string[];

  /** 현재 파일의 레이어 */
  currentLayer: string;

  /** import 대상의 레이어 */
  targetLayer: string;
}

/**
 * Healing 아이템 (위반 + 해결책)
 */
export interface HealingItem {
  /** 위반 정보 */
  violation: Violation;

  /** 해결책 */
  healing: HealingSuggestion;
}

/**
 * Healing 결과
 */
export interface HealingResult {
  /** 총 위반 수 */
  totalViolations: number;

  /** 자동 수정 가능한 위반 수 */
  autoFixable: number;

  /** Healing 아이템들 */
  items: HealingItem[];

  /** 분석된 파일 수 */
  filesAnalyzed: number;

  /** 분석 시간 (ms) */
  analysisTime: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Self-Healing Guard 검사
 *
 * 위반을 감지하고 각 위반에 대한 해결책을 제안합니다.
 *
 * @example
 * ```typescript
 * const result = await checkWithHealing({ preset: "fsd" }, process.cwd());
 *
 * // 위반 및 해결책 출력
 * for (const item of result.items) {
 *   console.log(`❌ ${item.violation.ruleName}`);
 *   console.log(`💡 ${item.healing.primary.label}`);
 * }
 *
 * // 자동 수정
 * for (const item of result.items) {
 *   if (item.healing.primary.autoFix) {
 *     const fix = await item.healing.primary.autoFix();
 *     console.log(fix.message);
 *   }
 * }
 * ```
 */
export async function checkWithHealing(
  config: GuardConfig,
  rootDir: string
): Promise<HealingResult> {
  const startTime = Date.now();

  // 기존 검사 실행
  const report = await checkDirectory(config, rootDir);

  // 각 위반에 대해 Healing 생성
  const items: HealingItem[] = [];
  let autoFixable = 0;

  for (const violation of report.violations) {
    const healing = generateHealing(violation, config, rootDir);
    items.push({ violation, healing });

    if (healing.primary.autoFix) {
      autoFixable++;
    }
  }

  return {
    totalViolations: report.totalViolations,
    autoFixable,
    items,
    filesAnalyzed: report.filesAnalyzed,
    analysisTime: Date.now() - startTime,
  };
}

/**
 * 단일 위반에 대한 Healing 생성
 */
export function generateHealing(
  violation: Violation,
  config: GuardConfig,
  rootDir: string
): HealingSuggestion {
  const context = createHealingContext(violation, config);
  const options = generateHealingOptions(violation, config, rootDir);

  // 우선순위로 정렬
  options.sort((a, b) => a.priority - b.priority);

  return {
    primary: options[0] ?? createFallbackOption(violation),
    alternatives: options.slice(1),
    context,
  };
}

/**
 * 자동 수정 실행
 */
export async function applyHealing(
  item: HealingItem,
  optionIndex: number = 0
): Promise<HealingFixResult> {
  const option =
    optionIndex === 0
      ? item.healing.primary
      : item.healing.alternatives[optionIndex - 1];

  if (!option?.autoFix) {
    return {
      success: false,
      message: "이 위반은 자동 수정을 지원하지 않습니다.",
    };
  }

  try {
    return await option.autoFix();
  } catch (error) {
    return {
      success: false,
      message: `자동 수정 실패: ${error instanceof Error ? error.message : String(error)}`,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * 모든 자동 수정 가능한 위반 수정
 */
export async function healAll(
  result: HealingResult
): Promise<{ fixed: number; failed: number; results: HealingFixResult[] }> {
  const results: HealingFixResult[] = [];
  let fixed = 0;
  let failed = 0;

  for (const item of result.items) {
    if (item.healing.primary.autoFix) {
      const fixResult = await applyHealing(item);
      results.push(fixResult);

      if (fixResult.success) {
        fixed++;
      } else {
        failed++;
      }
    }
  }

  return { fixed, failed, results };
}

// ═══════════════════════════════════════════════════════════════════════════
// Healing Option Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 위반 유형별 Healing 옵션 생성
 */
function generateHealingOptions(
  violation: Violation,
  config: GuardConfig,
  rootDir: string
): HealingOption[] {
  switch (violation.type) {
    case "layer-violation":
      return generateLayerViolationOptions(violation, config, rootDir);

    case "circular-dependency":
      return generateCircularDependencyOptions(violation, config, rootDir);

    case "cross-slice":
      return generateCrossSliceOptions(violation, config, rootDir);

    case "deep-nesting":
      return generateDeepNestingOptions(violation, config, rootDir);

    default:
      return [createFallbackOption(violation)];
  }
}

/**
 * 레이어 위반 옵션 생성
 */
function generateLayerViolationOptions(
  violation: Violation,
  _config: GuardConfig,
  rootDir: string
): HealingOption[] {
  const options: HealingOption[] = [];
  const { filePath, importPath, importStatement, toLayer, allowedLayers } = violation;

  const targetModule = extractModuleName(importPath);

  // 옵션 1: shared로 이동 (가장 권장)
  if (allowedLayers.includes("shared")) {
    try {
      const resolvedSourcePath = resolveImportPath(importPath, rootDir);
      // 원본 파일 확장자 보존 (.ts, .tsx, .jsx 등)
      const sourceExt = extname(resolvedSourcePath) || ".ts";
      const newPath = `@/shared/${targetModule.toLowerCase()}`;
      const newFilePath = join(rootDir, "src", "shared", targetModule.toLowerCase() + sourceExt);

      options.push({
        label: `"${targetModule}"를 shared 레이어로 이동`,
        explanation: `이 유틸/컴포넌트는 여러 레이어에서 사용되므로 shared에 위치해야 합니다.`,
        priority: 1,
        before: importStatement,
        after: importStatement.replace(importPath, newPath),
        moveFile: {
          from: resolvedSourcePath,
          to: newFilePath,
        },
        autoFix: createMoveFileAutoFix(
          filePath,
          importStatement,
          importPath,
          newPath,
          resolvedSourcePath,
          newFilePath,
          rootDir
        ),
      });
    } catch {
      // Path traversal 등 보안 이슈 시 옵션 생략
    }
  }

  // 옵션 2: import 문 변경 (dynamic import) - 수동 적용 필요 (async context 필요)
  if (violation.type === "layer-violation") {
    const dynamicImport = `const { ${targetModule} } = await import('${importPath}')`;

    options.push({
      label: "dynamic import로 변경 (수동)",
      explanation: "런타임에만 필요하다면 dynamic import로 레이어 의존성을 분리할 수 있습니다. (async 함수 내에서만 사용 가능)",
      priority: 2,
      before: importStatement,
      after: dynamicImport,
      // autoFix 제거: dynamic import는 async context가 필요하므로 자동 수정 불가
    });
  }

  // 옵션 3: Props로 전달 (수동)
  if (toLayer === "widgets" || toLayer === "features") {
    options.push({
      label: "Props로 전달받는 방식 사용",
      explanation: `상위 컴포넌트에서 ${targetModule}를 import하고 props로 전달하세요.`,
      priority: 3,
    });
  }

  // 옵션 4: 허용된 레이어에서 찾기 (수동)
  if (allowedLayers.length > 0) {
    options.push({
      label: "허용된 레이어에서 대안 찾기",
      explanation: `다음 레이어에서 import 가능: ${allowedLayers.map((l) => `@/${l}/*`).join(", ")}`,
      priority: 4,
    });
  }

  return options;
}

/**
 * 순환 의존 옵션 생성
 */
function generateCircularDependencyOptions(
  violation: Violation,
  _config: GuardConfig,
  _rootDir: string
): HealingOption[] {
  const options: HealingOption[] = [];
  const { fromLayer, toLayer } = violation;

  // 옵션 1: 공통 코드를 shared로 추출
  options.push({
    label: "공통 코드를 shared로 추출",
    explanation: `${fromLayer}와 ${toLayer}가 공유하는 코드를 shared 레이어로 이동하세요.`,
    priority: 1,
  });

  // 옵션 2: 인터페이스 분리
  options.push({
    label: "인터페이스/타입 분리",
    explanation: "의존성의 원인이 되는 타입을 별도 파일로 분리하세요.",
    priority: 2,
  });

  // 옵션 3: DI 패턴
  options.push({
    label: "Dependency Injection 적용",
    explanation: "런타임에 의존성을 주입하여 컴파일 타임 순환을 해결하세요.",
    priority: 3,
  });

  return options;
}

/**
 * Cross-slice 옵션 생성
 */
function generateCrossSliceOptions(
  violation: Violation,
  _config: GuardConfig,
  _rootDir: string
): HealingOption[] {
  const options: HealingOption[] = [];
  const { fromLayer, importPath } = violation;

  const targetSlice = extractSliceFromPath(importPath, fromLayer);

  // 옵션 1: 공통 로직을 shared 세그먼트로
  options.push({
    label: "공통 로직을 shared 세그먼트로 추출",
    explanation: `@/${fromLayer}/shared에 공통 로직을 위치시키세요.`,
    priority: 1,
  });

  // 옵션 2: @x notation
  options.push({
    label: "@x notation 사용 (명시적 cross-import)",
    explanation: `import { X } from '@/${fromLayer}/${targetSlice}/@x/...'`,
    priority: 2,
  });

  // 옵션 3: 상위 레이어에서 조합
  options.push({
    label: "상위 레이어에서 조합",
    explanation: "widgets나 pages에서 두 slice를 조합하여 사용하세요.",
    priority: 3,
  });

  return options;
}

/**
 * 깊은 중첩 옵션 생성
 */
function generateDeepNestingOptions(
  violation: Violation,
  _config: GuardConfig,
  _rootDir: string
): HealingOption[] {
  const options: HealingOption[] = [];
  const { filePath, importPath, importStatement } = violation;

  const parts = importPath.replace(/^[@~]\//, "").split("/");
  const publicApiPath = `@/${parts.slice(0, 2).join("/")}`;
  const targetModule = extractModuleName(importPath);

  // 옵션 1: Public API 사용
  options.push({
    label: "Public API를 통해 import",
    explanation: `내부 구현 대신 ${publicApiPath}에서 export된 항목을 사용하세요.`,
    priority: 1,
    before: importStatement,
    after: importStatement.replace(importPath, publicApiPath),
    autoFix: createReplaceImportAutoFix(
      filePath,
      importStatement,
      importStatement.replace(importPath, publicApiPath)
    ),
  });

  // 옵션 2: index.ts에 export 추가
  options.push({
    label: "Public API에 export 추가",
    explanation: `${publicApiPath}/index.ts에서 ${targetModule}를 export하세요.`,
    priority: 2,
  });

  return options;
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto Fix Creators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * import 문 교체 자동 수정
 */
function createReplaceImportAutoFix(
  filePath: string,
  oldImport: string,
  newImport: string
): () => Promise<HealingFixResult> {
  return async () => {
    try {
      const content = await readFile(filePath, "utf-8");
      const newContent = content.replace(oldImport, newImport);

      if (content === newContent) {
        return {
          success: false,
          message: "변경할 import를 찾을 수 없습니다.",
        };
      }

      await writeFile(filePath, newContent, "utf-8");

      return {
        success: true,
        message: `Import 문을 수정했습니다:\n  변경 전: ${oldImport}\n  변경 후: ${newImport}`,
        changedFiles: [filePath],
      };
    } catch (error) {
      return {
        success: false,
        message: `파일 수정 실패: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };
}

/**
 * 파일 이동 자동 수정
 */
function createMoveFileAutoFix(
  importingFile: string,
  oldImport: string,
  oldPath: string,
  newPath: string,
  oldFilePath: string,
  newFilePath: string,
  rootDir: string
): () => Promise<HealingFixResult> {
  return async () => {
    try {
      const changedFiles: string[] = [];

      // 0. 보안 검증: 모든 경로가 rootDir 내에 있는지 확인
      if (!isPathWithinRoot(oldFilePath, rootDir) ||
          !isPathWithinRoot(newFilePath, rootDir) ||
          !isPathWithinRoot(importingFile, rootDir)) {
        return {
          success: false,
          message: "보안 오류: 파일 경로가 프로젝트 루트를 벗어납니다.",
        };
      }

      // 1. 소스 파일 존재 확인 (필수)
      if (!existsSync(oldFilePath)) {
        return {
          success: false,
          message: `소스 파일이 존재하지 않습니다: ${oldFilePath}`,
        };
      }

      // 2. 대상 디렉토리 생성
      const targetDir = dirname(newFilePath);
      if (!existsSync(targetDir)) {
        await mkdir(targetDir, { recursive: true });
      }

      // 3. 파일 복사 (먼저 복사, 나중에 삭제)
      const content = await readFile(oldFilePath, "utf-8");
      await writeFile(newFilePath, content, "utf-8");
      changedFiles.push(newFilePath);

      // 4. import 문 업데이트 (파일 삭제 전에 먼저 수행)
      const importingContent = await readFile(importingFile, "utf-8");
      const newImport = oldImport.replace(oldPath, newPath);
      const newImportingContent = importingContent.replace(oldImport, newImport);

      if (importingContent !== newImportingContent) {
        await writeFile(importingFile, newImportingContent, "utf-8");
        changedFiles.push(importingFile);
      }

      // 5. 모든 작업 성공 후에만 원본 파일 삭제
      await unlink(oldFilePath);
      changedFiles.push(oldFilePath);

      return {
        success: true,
        message: `파일을 이동하고 import를 업데이트했습니다:\n  ${oldFilePath} → ${newFilePath}`,
        changedFiles,
      };
    } catch (error) {
      return {
        success: false,
        message: `파일 이동 실패: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Healing 컨텍스트 생성
 */
function createHealingContext(
  violation: Violation,
  config: GuardConfig
): HealingContext {
  return {
    layerHierarchy: getLayerHierarchy(config.preset),
    rule: violation.ruleName,
    ruleDescription: violation.ruleDescription,
    documentation: getDocumentationLink(config.preset, "layers"),
    allowedLayers: violation.allowedLayers,
    currentLayer: violation.fromLayer,
    targetLayer: violation.toLayer,
  };
}

/**
 * 레이어 계층 구조 문자열 반환
 */
function getLayerHierarchy(preset?: GuardPreset): string {
  switch (preset) {
    case "fsd":
      return "app → pages → widgets → features → entities → shared";
    case "clean":
      return "api → application → domain → infrastructure";
    case "hexagonal":
      return "adapters → ports → domain";
    case "atomic":
      return "pages → templates → organisms → molecules → atoms";
    case "cqrs":
      return "api → commands|queries → dto/events → domain → shared";
    case "mandu":
      return "client(FSD) | shared | server(Clean)";
    default:
      return "unknown";
  }
}

/**
 * 폴백 옵션 생성
 */
function createFallbackOption(violation: Violation): HealingOption {
  return {
    label: "수동으로 검토 필요",
    explanation: violation.suggestions[0] ?? "이 위반은 수동으로 검토가 필요합니다.",
    priority: 100,
  };
}

/**
 * import 경로에서 모듈 이름 추출
 */
function extractModuleName(importPath: string): string {
  const parts = importPath.replace(/^[@~]\//, "").split("/");
  const lastPart = parts[parts.length - 1].replace(/\.(ts|tsx|js|jsx)$/, "");
  return lastPart.charAt(0).toUpperCase() + lastPart.slice(1);
}

/**
 * 경로가 rootDir 내에 있는지 검증 (Path Traversal 방지)
 */
function isPathWithinRoot(targetPath: string, rootDir: string): boolean {
  const normalizedTarget = normalize(resolve(targetPath));
  const normalizedRoot = normalize(resolve(rootDir));
  return normalizedTarget.startsWith(normalizedRoot);
}

/**
 * import 경로를 실제 파일 경로로 변환
 * @throws Path Traversal 시도 시 에러
 */
function resolveImportPath(importPath: string, rootDir: string): string {
  // Path Traversal 패턴 차단
  if (importPath.includes("..") || importPath.includes("\\..") || importPath.includes("/..")) {
    throw new Error(`Invalid import path (path traversal attempt): ${importPath}`);
  }

  const cleanPath = importPath.replace(/^[@~]\//, "");
  const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

  for (const ext of extensions) {
    const fullPath = join(rootDir, "src", cleanPath + ext);

    // 최종 경로가 rootDir 내에 있는지 검증
    if (!isPathWithinRoot(fullPath, rootDir)) {
      throw new Error(`Invalid path (outside project root): ${fullPath}`);
    }

    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  const defaultPath = join(rootDir, "src", cleanPath + ".ts");
  if (!isPathWithinRoot(defaultPath, rootDir)) {
    throw new Error(`Invalid path (outside project root): ${defaultPath}`);
  }

  return defaultPath;
}

/**
 * 경로에서 슬라이스 추출
 */
function extractSliceFromPath(importPath: string, fromLayer?: string): string {
  const parts = importPath.replace(/^[@~]\//, "").split("/");
  if (fromLayer) {
    const layerParts = fromLayer.split("/");
    if (parts.length > layerParts.length) {
      return parts[layerParts.length];
    }
  }
  return parts[1] ?? "unknown";
}

// ═══════════════════════════════════════════════════════════════════════════
// Explanation API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 규칙 설명 가져오기
 *
 * @example
 * ```typescript
 * const explanation = explainRule("layer-violation", "shared", "client", "fsd");
 * console.log(explanation.why);
 * console.log(explanation.how);
 * ```
 */
export interface RuleExplanation {
  /** 규칙 이름 */
  rule: string;

  /** 왜 이게 잘못인지 */
  why: string;

  /** 어떻게 고쳐야 하는지 */
  how: string;

  /** 관련 문서 */
  documentation: string;

  /** 예시 */
  examples: {
    bad: string;
    good: string;
  };
}

/**
 * 규칙 설명 생성
 */
export function explainRule(
  type: ViolationType,
  fromLayer: string,
  toLayer: string,
  preset?: GuardPreset
): RuleExplanation {
  const documentation = getDocumentationLink(preset, "layers");

  switch (type) {
    case "layer-violation":
      return {
        rule: "layer-violation",
        why: `"${fromLayer}" 레이어는 "${toLayer}" 레이어를 import할 수 없습니다.\n` +
          `레이어 의존 규칙: 상위 레이어는 하위 레이어만 import 가능합니다.\n` +
          `계층 구조: ${getLayerHierarchy(preset)}`,
        how: `1. 공통으로 사용되는 코드는 shared 레이어로 이동\n` +
          `2. 또는 Props/Context를 통해 상위에서 주입\n` +
          `3. 또는 dynamic import로 런타임 의존성으로 전환`,
        documentation,
        examples: {
          bad: `// ❌ ${fromLayer}에서 ${toLayer} import\nimport { X } from '@/${toLayer}/...'`,
          good: `// ✅ shared에서 import\nimport { X } from '@/shared/...'`,
        },
      };

    case "circular-dependency":
      return {
        rule: "circular-dependency",
        why: `"${fromLayer}"와 "${toLayer}" 사이에 순환 의존이 발생했습니다.\n` +
          `순환 의존은 빌드 에러, 런타임 에러, 유지보수 어려움을 유발합니다.`,
        how: `1. 공통 의존성을 shared로 추출\n` +
          `2. 인터페이스/타입을 별도 파일로 분리\n` +
          `3. Dependency Injection 패턴 적용`,
        documentation,
        examples: {
          bad: `// ❌ A → B → A 순환\nA.ts: import { B } from './B'\nB.ts: import { A } from './A'`,
          good: `// ✅ shared로 분리\nA.ts: import { Common } from '@/shared'\nB.ts: import { Common } from '@/shared'`,
        },
      };

    case "cross-slice":
      return {
        rule: "cross-slice",
        why: `같은 레이어(${fromLayer}) 내에서 다른 슬라이스를 직접 import하고 있습니다.\n` +
          `슬라이스 간 의존은 결합도를 높이고 독립적인 개발을 방해합니다.`,
        how: `1. 공통 로직을 shared 세그먼트로 추출\n` +
          `2. @x notation으로 명시적 cross-import 사용\n` +
          `3. 상위 레이어에서 조합`,
        documentation,
        examples: {
          bad: `// ❌ features/auth에서 features/user import\nimport { User } from '@/features/user'`,
          good: `// ✅ shared 사용\nimport { User } from '@/shared/types'`,
        },
      };

    case "deep-nesting":
      return {
        rule: "deep-nesting",
        why: `내부 구현 파일을 직접 import하고 있습니다.\n` +
          `이는 캡슐화를 깨고, 내부 리팩토링 시 import 변경이 필요해집니다.`,
        how: `1. Public API (index.ts)를 통해 import\n` +
          `2. index.ts에 필요한 export 추가`,
        documentation,
        examples: {
          bad: `// ❌ 내부 구현 직접 import\nimport { X } from '@/features/auth/model/store'`,
          good: `// ✅ Public API 사용\nimport { X } from '@/features/auth'`,
        },
      };

    default:
      return {
        rule: type,
        why: "알 수 없는 위반 유형입니다.",
        how: "문서를 참조하세요.",
        documentation,
        examples: {
          bad: "",
          good: "",
        },
      };
  }
}

import { readFileSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { getAtePaths, ensureDir } from "./fs";
import type { HealInput } from "./types";
import { parseTrace, generateAlternativeSelectors } from "./trace-parser";
import { execSync } from "node:child_process";

export interface HealSuggestion {
  kind: "selector-map" | "test-code" | "note";
  title: string;
  diff: string; // unified diff suggestion (no auto-commit)
  metadata?: {
    selector?: string;
    alternatives?: string[];
    testFile?: string;
  };
}

// Phase 4: 7종 실패 원인 분류 (#ATE-P4)
export type FailureCategory =
  | "selector-stale"         // DOM 구조 변경 → 대체 셀렉터 제안
  | "api-shape-changed"      // API 응답 스키마 변경 → assertion diff
  | "component-restructured" // 컴포넌트 리팩토링 → selector-map 전체 재빌드
  | "race-condition"         // 타이밍 이슈 → waitForResponse 삽입
  | "timeout"                // 네트워크/렌더링 지연 → timeout 증가
  | "assertion-mismatch"     // 예상 값 변경 → 예상 값 업데이트
  | "unknown";

// 하위 호환성 유지
export type LegacyFailureCategory = "selector" | "timeout" | "assertion" | "unknown";

export interface FeedbackAnalysis {
  category: FailureCategory;
  suggestions: HealSuggestion[];
  autoApplicable: boolean;
  priority: number; // 1-10, higher = more confident
  reasoning: string;
}

export interface FeedbackInput {
  repoRoot: string;
  runId: string;
  autoApply?: boolean;
}

export interface ApplyHealInput {
  repoRoot: string;
  runId: string;
  healIndex: number;
  createBackup?: boolean;
}

export interface ApplyHealResult {
  success: boolean;
  appliedFile: string;
  backupPath?: string;
  error?: string;
}

/**
 * Healing Engine
 * - Parses Playwright trace/report to find failed locators
 * - Generates alternative selector suggestions
 * - Creates unified diffs for selector-map.json or test files
 * - Does NOT auto-commit or patch files (user must review and apply)
 */
export function heal(input: HealInput): { attempted: true; suggestions: HealSuggestion[] } {
  const paths = getAtePaths(input.repoRoot);
  const reportDir = join(paths.reportsDir, input.runId || "latest");
  const jsonReportPath = join(reportDir, "playwright-report.json");

  // Try to read Playwright report
  if (!existsSync(jsonReportPath)) {
    return {
      attempted: true,
      suggestions: [{ kind: "note", title: "No Playwright JSON report found", diff: "" }],
    };
  }

  const suggestions: HealSuggestion[] = [];

  try {
    // Parse trace to extract failed locators
    const parseResult = parseTrace(jsonReportPath);

    if (parseResult.failedLocators.length === 0) {
      suggestions.push({
        kind: "note",
        title: "No failed locators detected in trace",
        diff: "",
      });
      return { attempted: true, suggestions };
    }

    // Generate healing suggestions for each failed locator
    for (const failed of parseResult.failedLocators) {
      const alternatives = generateAlternativeSelectors(failed.selector, failed.actionType);

      if (alternatives.length === 0) {
        suggestions.push({
          kind: "note",
          title: `Failed locator: ${failed.selector} (no alternatives)`,
          diff: "",
          metadata: {
            selector: failed.selector,
            alternatives: [],
          },
        });
        continue;
      }

      // Generate selector-map diff
      const selectorMapDiff = generateSelectorMapDiff(failed.selector, alternatives);
      suggestions.push({
        kind: "selector-map",
        title: `Update selector-map for: ${failed.selector}`,
        diff: selectorMapDiff,
        metadata: {
          selector: failed.selector,
          alternatives,
        },
      });

      // If we have test file context, generate test code diff
      if (parseResult.metadata.testFile && failed.context) {
        const testCodeDiff = generateTestCodeDiff(
          parseResult.metadata.testFile,
          failed.selector,
          alternatives[0], // Use first alternative
          failed.context,
        );

        if (testCodeDiff) {
          suggestions.push({
            kind: "test-code",
            title: `Update test code: ${failed.selector} → ${alternatives[0]}`,
            diff: testCodeDiff,
            metadata: {
              selector: failed.selector,
              alternatives,
              testFile: parseResult.metadata.testFile,
            },
          });
        }
      }
    }
  } catch (err) {
    suggestions.push({
      kind: "note",
      title: `Healing failed: ${String(err)}`,
      diff: "",
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      kind: "note",
      title: "No healing suggestions available",
      diff: "",
    });
  }

  return { attempted: true, suggestions };
}

/**
 * Generate unified diff for selector-map.json
 */
function generateSelectorMapDiff(originalSelector: string, alternatives: string[]): string {
  const escapedSelector = JSON.stringify(originalSelector);
  const alternativesJson = JSON.stringify(alternatives, null, 2).split("\n").join("\n+    ");

  const lines = [
    "--- a/.mandu/selector-map.json",
    "+++ b/.mandu/selector-map.json",
    "@@ -1,3 +1,8 @@",
    " {",
    "+  " + escapedSelector + ": {",
    "+    \"fallbacks\": " + alternativesJson,
    "+  },",
    "   \"version\": \"1.0.0\"",
    " }",
    "",
  ];

  return lines.join("\n");
}

/**
 * Generate unified diff for test code file
 */
function generateTestCodeDiff(
  testFile: string,
  originalSelector: string,
  newSelector: string,
  context: string,
): string | null {
  // Escape special regex characters
  const _escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Try to infer the line content from context
  const contextLine = context.trim();

  if (!contextLine) {
    return null;
  }

  const lines = [
    `--- a/${testFile}`,
    `+++ b/${testFile}`,
    "@@ -1,3 +1,3 @@",
    ` // ${contextLine}`,
    `-await page.locator('${originalSelector}')`,
    `+await page.locator('${newSelector}')`,
    "",
  ];

  return lines.join("\n");
}

/**
 * Phase 4: 심층 실패 원인 분류 (#ATE-P4)
 * Playwright report JSON에서 에러 메시지를 추출하여 7종으로 분류
 */
function classifyFailure(reportPath: string, suggestions: HealSuggestion[]): {
  category: FailureCategory;
  reasoning: string;
  priority: number;
  autoApplicable: boolean;
} {
  const hasSelector = suggestions.some((s) => s.kind === "selector-map");
  const hasTestCode = suggestions.some((s) => s.kind === "test-code");
  const onlyNotes = suggestions.every((s) => s.kind === "note");

  // Report JSON에서 에러 패턴 분석
  let errorText = "";
  try {
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      errorText = JSON.stringify(report).toLowerCase();
    }
  } catch { /* parse error — continue with suggestion-based classification */ }

  // Race condition 감지: "strict mode violation", "detached", "intercepted"
  if (errorText.includes("strict mode violation") || errorText.includes("detached") ||
      errorText.includes("intercepted by another")) {
    return {
      category: "race-condition",
      reasoning: "Element was detached or intercepted — likely a timing/race condition. Consider adding page.waitForResponse() or page.waitForLoadState().",
      priority: 7,
      autoApplicable: false,
    };
  }

  // API shape changed: "expected.*to have property", "toMatchObject", "schema"
  if (errorText.includes("to have property") || errorText.includes("tomatchobject") ||
      errorText.includes("expected.*received") || errorText.includes("contract")) {
    return {
      category: "api-shape-changed",
      reasoning: "API response shape doesn't match expected schema. Update assertions to match new response structure.",
      priority: 8,
      autoApplicable: false,
    };
  }

  // Component restructured: 다수의 selector 실패 (3개 이상)
  if (hasSelector && suggestions.filter((s) => s.kind === "selector-map").length >= 3) {
    return {
      category: "component-restructured",
      reasoning: "Multiple selectors failed — component was likely restructured. Full selector-map rebuild recommended.",
      priority: 9,
      autoApplicable: false,
    };
  }

  // Selector stale: 단일 selector 실패
  if (hasSelector) {
    return {
      category: "selector-stale",
      reasoning: "DOM structure changed — single selector needs update. Selector-map update is safe to auto-apply.",
      priority: 8,
      autoApplicable: true,
    };
  }

  // Assertion mismatch: 테스트 코드 수정 제안
  if (hasTestCode) {
    return {
      category: "assertion-mismatch",
      reasoning: "Expected value changed. Test assertion needs updating to match new behavior.",
      priority: 6,
      autoApplicable: false,
    };
  }

  // Timeout
  if (onlyNotes) {
    const noteText = suggestions[0]?.title.toLowerCase() || "";
    if (noteText.includes("timeout") || errorText.includes("timeout") || errorText.includes("exceeded")) {
      return {
        category: "timeout",
        reasoning: "Operation timed out. Consider increasing timeout or adding explicit wait conditions.",
        priority: 4,
        autoApplicable: false,
      };
    }
  }

  return {
    category: "unknown",
    reasoning: "Unable to classify failure automatically. Manual investigation required.",
    priority: 3,
    autoApplicable: false,
  };
}

/**
 * Phase 4.3: Heal 이력 학습 (#ATE-P4)
 * 이전 heal 적용 결과를 기록하고, 동일 패턴 반복 시 자동 적용 신뢰도 상향
 */
interface HealHistoryEntry {
  timestamp: number;
  runId: string;
  category: FailureCategory;
  selector?: string;
  applied: boolean;
  success: boolean;
}

function loadHealHistory(repoRoot: string): HealHistoryEntry[] {
  const historyPath = join(repoRoot, ".mandu", "ate", "heal-history.json");
  try {
    if (existsSync(historyPath)) {
      return JSON.parse(readFileSync(historyPath, "utf8"));
    }
  } catch { /* corrupt file — start fresh */ }
  return [];
}

function saveHealHistory(repoRoot: string, entries: HealHistoryEntry[]): void {
  const dir = join(repoRoot, ".mandu", "ate");
  ensureDir(dir);
  const historyPath = join(dir, "heal-history.json");
  // 최근 200개만 유지
  const trimmed = entries.slice(-200);
  writeFileSync(historyPath, JSON.stringify(trimmed, null, 2), "utf8");
}

export function recordHealResult(repoRoot: string, entry: HealHistoryEntry): void {
  const history = loadHealHistory(repoRoot);
  history.push(entry);
  saveHealHistory(repoRoot, history);
}

/**
 * 동일 패턴의 이전 heal 성공률을 기반으로 신뢰도 보정
 */
function getHistoryBoost(repoRoot: string, category: FailureCategory, selector?: string): number {
  const history = loadHealHistory(repoRoot);
  const relevant = history.filter((h) =>
    h.category === category && h.applied && (!selector || h.selector === selector)
  );
  if (relevant.length === 0) return 0;
  const successRate = relevant.filter((h) => h.success).length / relevant.length;
  // 성공률 80% 이상이면 우선순위 +2
  return successRate >= 0.8 ? 2 : successRate >= 0.5 ? 1 : 0;
}

/**
 * Analyze test failure feedback and categorize for heal suggestions
 */
export function analyzeFeedback(input: FeedbackInput): FeedbackAnalysis {
  const healResult = heal({
    repoRoot: input.repoRoot,
    runId: input.runId,
  });

  if (!healResult.attempted || healResult.suggestions.length === 0) {
    return {
      category: "unknown",
      suggestions: [],
      autoApplicable: false,
      priority: 0,
      reasoning: "No healing suggestions available",
    };
  }

  // Phase 4: 심층 분류
  const paths = getAtePaths(input.repoRoot);
  const reportDir = join(paths.reportsDir, input.runId || "latest");
  const reportPath = join(reportDir, "playwright-report.json");
  const classification = classifyFailure(reportPath, healResult.suggestions);

  // Phase 4.3: 이력 기반 신뢰도 보정
  const historyBoost = getHistoryBoost(
    input.repoRoot,
    classification.category,
    healResult.suggestions[0]?.metadata?.selector,
  );

  return {
    category: classification.category,
    suggestions: healResult.suggestions,
    autoApplicable: classification.autoApplicable && (input.autoApply ?? false),
    priority: Math.min(10, classification.priority + historyBoost),
    reasoning: classification.reasoning + (historyBoost > 0 ? ` (confidence +${historyBoost} from heal history)` : ""),
  };
}

/**
 * Check if git working directory has uncommitted changes
 */
function hasUncommittedChanges(repoRoot: string): boolean {
  try {
    const result = execSync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return result.trim().length > 0;
  } catch {
    // Not a git repo or git not available
    return false;
  }
}

/**
 * Apply a heal suggestion diff to the actual file
 */
export function applyHeal(input: ApplyHealInput): ApplyHealResult {
  const paths = getAtePaths(input.repoRoot);
  const reportDir = join(paths.reportsDir, input.runId);

  // Get heal suggestions
  const healResult = heal({
    repoRoot: input.repoRoot,
    runId: input.runId,
  });

  if (!healResult.attempted || healResult.suggestions.length === 0) {
    return {
      success: false,
      appliedFile: "",
      error: "No heal suggestions available",
    };
  }

  if (input.healIndex < 0 || input.healIndex >= healResult.suggestions.length) {
    return {
      success: false,
      appliedFile: "",
      error: `Invalid heal index: ${input.healIndex} (available: 0-${healResult.suggestions.length - 1})`,
    };
  }

  const suggestion = healResult.suggestions[input.healIndex];

  // Only apply selector-map or test-code suggestions
  if (suggestion.kind === "note") {
    return {
      success: false,
      appliedFile: "",
      error: "Cannot apply note-type suggestions",
    };
  }

  // Safety check: require backup if working directory is dirty
  const createBackup = input.createBackup ?? true;
  if (!createBackup && hasUncommittedChanges(input.repoRoot)) {
    return {
      success: false,
      appliedFile: "",
      error: "Backup required: git working directory has uncommitted changes",
    };
  }

  let targetFile: string;
  let backupPath: string | undefined;

  try {
    if (suggestion.kind === "selector-map") {
      targetFile = paths.selectorMapPath;

      // Create backup
      if (createBackup) {
        ensureDir(reportDir);
        backupPath = join(reportDir, `selector-map.backup-${Date.now()}.json`);
        if (existsSync(targetFile)) {
          copyFileSync(targetFile, backupPath);
        }
      }

      // Apply selector-map diff
      const currentContent = existsSync(targetFile)
        ? JSON.parse(readFileSync(targetFile, "utf8"))
        : { version: "1.0.0" };

      // Extract selector and alternatives from metadata
      const { selector, alternatives } = suggestion.metadata || {};
      if (!selector || !alternatives || alternatives.length === 0) {
        throw new Error("Invalid suggestion metadata");
      }

      // Update selector-map
      currentContent[selector] = {
        fallbacks: alternatives,
      };

      writeFileSync(targetFile, JSON.stringify(currentContent, null, 2), "utf8");
    } else if (suggestion.kind === "test-code") {
      // Test code modification - extract file path from metadata
      const testFile = suggestion.metadata?.testFile;
      if (!testFile) {
        throw new Error("No test file specified in suggestion metadata");
      }

      targetFile = join(input.repoRoot, testFile);

      if (!existsSync(targetFile)) {
        throw new Error(`Test file not found: ${targetFile}`);
      }

      // Create backup
      if (createBackup) {
        ensureDir(reportDir);
        backupPath = join(reportDir, `${testFile.replace(/\//g, "_")}.backup-${Date.now()}`);
        copyFileSync(targetFile, backupPath);
      }

      // Apply test code diff (simple string replacement)
      const { selector, alternatives } = suggestion.metadata || {};
      if (!selector || !alternatives || alternatives.length === 0) {
        throw new Error("Invalid suggestion metadata");
      }

      const content = readFileSync(targetFile, "utf8");
      const newContent = content.replace(
        new RegExp(`locator\\(['"\`]${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"\`]\\)`, "g"),
        `locator('${alternatives[0]}')`,
      );

      writeFileSync(targetFile, newContent, "utf8");
    } else {
      return {
        success: false,
        appliedFile: "",
        error: `Unsupported suggestion kind: ${suggestion.kind}`,
      };
    }

    // Phase 4.3: Heal 이력 기록
    recordHealResult(input.repoRoot, {
      timestamp: Date.now(),
      runId: input.runId,
      category: "selector-stale", // applyHeal은 주로 selector 수정
      selector: suggestion.metadata?.selector,
      applied: true,
      success: true,
    });

    return {
      success: true,
      appliedFile: targetFile,
      backupPath,
    };
  } catch (err) {
    // 실패도 기록
    recordHealResult(input.repoRoot, {
      timestamp: Date.now(),
      runId: input.runId,
      category: "unknown",
      selector: undefined,
      applied: true,
      success: false,
    });

    return {
      success: false,
      appliedFile: targetFile!,
      backupPath,
      error: String(err),
    };
  }
}

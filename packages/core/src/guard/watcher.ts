/**
 * Mandu Guard Watcher
 *
 * 실시간 파일 감시
 */

import { watch, type FSWatcher } from "chokidar";
import { resolve } from "path";
import type {
  GuardConfig,
  GuardWatcher,
  LayerDefinition,
  ViolationReport,
  WatcherEvent,
  Violation,
  Severity,
  ViolationType,
  FileAnalysis,
} from "./types";
import { WATCH_EXTENSIONS, DEFAULT_GUARD_CONFIG } from "./types";
import { analyzeFile, shouldAnalyzeFile } from "./analyzer";
import { validateFileAnalysis, detectCircularDependencies } from "./validator";
import {
  printRealtimeViolation,
  formatViolationForAgent,
  formatViolationAsAgentJSON,
} from "./reporter";
import { getPreset } from "./presets";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface WatcherOptions {
  config: GuardConfig;
  rootDir: string;
  onViolation?: (violation: Violation) => void;
  onFileAnalyzed?: (analysis: FileAnalysis, violations: Violation[]) => void;
  silent?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache
// ═══════════════════════════════════════════════════════════════════════════

const analysisCache = new Map<string, FileAnalysis>();

let globModulePromise: Promise<typeof import("glob")> | null = null;

async function getGlobModule(): Promise<typeof import("glob")> {
  if (!globModulePromise) {
    globModulePromise = import("glob");
  }
  return globModulePromise;
}

/**
 * 캐시 초기화
 */
export function clearAnalysisCache(): void {
  analysisCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// Debounce
// ═══════════════════════════════════════════════════════════════════════════

const debounceTimers = new Map<string, NodeJS.Timeout>();

function debounce(key: string, fn: () => void, ms: number): void {
  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      fn();
    }, ms)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Guard Watcher Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Guard Watcher 생성
 */
export function createGuardWatcher(options: WatcherOptions): GuardWatcher {
  const { config, rootDir, onViolation, onFileAnalyzed, silent } = options;

  // 레이어 정의 가져오기
  const layers = resolveLayerDefinitions(config);
  const hierarchy = resolveHierarchy(config);

  // 설정 기본값 적용
  const srcDir = config.srcDir ?? DEFAULT_GUARD_CONFIG.srcDir;
  const debounceMs = config.debounceMs ?? DEFAULT_GUARD_CONFIG.debounceMs;
  const exclude = config.exclude ?? DEFAULT_GUARD_CONFIG.exclude;

  let watcher: FSWatcher | null = null;

  /**
   * 파일 분석 및 검증
   */
  async function processFile(filePath: string, event: WatcherEvent): Promise<void> {
    // 삭제된 파일
    if (event === "unlink") {
      analysisCache.delete(filePath);
      return;
    }

    // 분석 대상인지 확인
    if (!shouldAnalyzeFile(filePath, config, rootDir)) {
      return;
    }

    try {
      // 파일 분석
      const analysis = await analyzeFile(filePath, layers, rootDir);

      // 캐시 저장
      if (config.cache !== false) {
        analysisCache.set(filePath, analysis);
      }

      // 검증
      const violations = validateFileAnalysis(analysis, layers, config);

      // 콜백 호출
      onFileAnalyzed?.(analysis, violations);

      const realtimeOutput = config.realtimeOutput ?? DEFAULT_GUARD_CONFIG.realtimeOutput;

      // 위반 처리
      for (const violation of violations) {
        onViolation?.(violation);

        if (!silent) {
          switch (realtimeOutput) {
            case "agent":
              console.log(formatViolationForAgent(violation, config.preset));
              break;
            case "json":
              console.log(formatViolationAsAgentJSON(violation, config.preset));
              break;
            case "console":
            default:
              printRealtimeViolation(violation);
          }
        }
      }
    } catch (error) {
      if (!silent) {
        console.error(`[Guard] Error analyzing ${filePath}:`, error);
      }
    }
  }

  /**
   * 파일 변경 핸들러
   */
  function handleFileChange(event: WatcherEvent, filePath: string): void {
    debounce(filePath, () => processFile(filePath, event), debounceMs);
  }

  /**
   * 전체 스캔
   */
  async function scanAll(): Promise<ViolationReport> {
    const startTime = Date.now();
    const violations: Violation[] = [];
    const files: string[] = [];
    const analyses: FileAnalysis[] = [];

    // 글로브로 모든 파일 찾기
    const { glob } = await getGlobModule();
    const extensions = WATCH_EXTENSIONS.map((ext) => ext.slice(1)).join(",");
    const scanRoots = new Set<string>([srcDir]);
    if (config.fsRoutes) {
      scanRoots.add("app");
    }

    const foundFilesSet = new Set<string>();
    for (const root of scanRoots) {
      const pattern = `${root}/**/*.{${extensions}}`;
      const foundFiles = await glob(pattern, {
        cwd: rootDir,
        ignore: exclude,
        absolute: true,
      });
      for (const file of foundFiles) {
        foundFilesSet.add(file);
      }
    }

    const foundFiles = Array.from(foundFilesSet);

    // 각 파일 분석
    for (const filePath of foundFiles) {
      if (!shouldAnalyzeFile(filePath, config, rootDir)) {
        continue;
      }

      files.push(filePath);

      try {
        const analysis = await analyzeFile(filePath, layers, rootDir);
        analyses.push(analysis);
        const fileViolations = validateFileAnalysis(analysis, layers, config);
        violations.push(...fileViolations);

        if (config.cache !== false) {
          analysisCache.set(filePath, analysis);
        }
      } catch (error) {
        if (!silent) {
          console.error(`[Guard] Error analyzing ${filePath}:`, error);
        }
      }
    }

    const endTime = Date.now();

    // 순환 의존성 검사 (전체 스캔에서만)
    if (analyses.length > 0) {
      violations.push(...detectCircularDependencies(analyses, layers, config));
    }

    // 리포트 생성
    const report: ViolationReport = {
      totalViolations: violations.length,
      bySeverity: countBySeverity(violations),
      byType: countByType(violations),
      violations,
      filesAnalyzed: files.length,
      analysisTime: endTime - startTime,
    };

    return report;
  }

  return {
    start(): void {
      const scanRoots = new Set<string>([srcDir]);
      if (config.fsRoutes) {
        scanRoots.add("app");
      }

      const watchPatterns = Array.from(scanRoots).flatMap((root) =>
        WATCH_EXTENSIONS.map((ext) => `${root}/**/*${ext}`)
      );

      watcher = watch(watchPatterns, {
        cwd: rootDir,
        ignored: exclude,
        persistent: true,
        ignoreInitial: false,
      });

      watcher.on("add", (path) => handleFileChange("add", resolve(rootDir, path)));
      watcher.on("change", (path) => handleFileChange("change", resolve(rootDir, path)));
      watcher.on("unlink", (path) => handleFileChange("unlink", resolve(rootDir, path)));

      const realtimeOutput = config.realtimeOutput ?? DEFAULT_GUARD_CONFIG.realtimeOutput;
      if (!silent && realtimeOutput === "console") {
        console.log(`[Guard] 🛡️  Watching ${Array.from(scanRoots).join(", ")} for architecture violations...`);
      }
    },

    close(): void {
      if (watcher) {
        void watcher.close();
        watcher = null;
      }
      clearAnalysisCache();
    },

    scanAll,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 레이어 정의 해석
 */
function resolveLayerDefinitions(config: GuardConfig): LayerDefinition[] {
  // 커스텀 레이어가 있으면 사용
  if (config.layers && config.layers.length > 0) {
    return config.layers;
  }

  // 프리셋 사용
  if (config.preset) {
    const preset = getPreset(config.preset);
    let layers = [...preset.layers];

    // 오버라이드 적용
    if (config.override?.layers) {
      layers = layers.map((layer) => {
        const override = config.override?.layers?.[layer.name];
        if (override) {
          return { ...layer, ...override };
        }
        return layer;
      });
    }

    return layers;
  }

  return [];
}

/**
 * 계층 구조 해석
 */
function resolveHierarchy(config: GuardConfig): string[] {
  if (config.preset) {
    const preset = getPreset(config.preset);
    return preset.hierarchy;
  }
  return [];
}

/**
 * 심각도별 카운트
 */
function countBySeverity(violations: Violation[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    error: 0,
    warn: 0,
    info: 0,
  };

  for (const v of violations) {
    counts[v.severity]++;
  }

  return counts;
}

/**
 * 타입별 카운트
 */
function countByType(violations: Violation[]): Record<ViolationType, number> {
  const counts: Record<ViolationType, number> = {
    "layer-violation": 0,
    "circular-dependency": 0,
    "cross-slice": 0,
    "deep-nesting": 0,
    "file-type": 0,
    "invalid-shared-segment": 0,
  };

  for (const v of violations) {
    counts[v.type]++;
  }

  return counts;
}

// ═══════════════════════════════════════════════════════════════════════════
// Convenience Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 단일 파일 검사 (일회성)
 */
export async function checkFile(
  filePath: string,
  config: GuardConfig,
  rootDir: string
): Promise<Violation[]> {
  const layers = resolveLayerDefinitions(config);

  if (!shouldAnalyzeFile(filePath, config, rootDir)) {
    return [];
  }

  const analysis = await analyzeFile(filePath, layers, rootDir);
  return validateFileAnalysis(analysis, layers, config);
}

/**
 * 디렉토리 전체 검사 (일회성)
 */
export async function checkDirectory(
  config: GuardConfig,
  rootDir: string
): Promise<ViolationReport> {
  const watcher = createGuardWatcher({
    config,
    rootDir,
    silent: true,
  });

  return watcher.scanAll();
}

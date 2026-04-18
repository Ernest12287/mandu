/**
 * Mandu Dev Bundler 🔥
 * 개발 모드 번들링 + HMR (Hot Module Replacement)
 */

import type { RoutesManifest, RouteSpec } from "../spec/schema";
import { buildClientBundles } from "./build";
import type { BundleResult } from "./types";
import { PORTS, TIMEOUTS } from "../constants";
import { mark, measure, withPerf } from "../perf";
import { HMR_PERF } from "../perf/hmr-markers";
import type {
  CoalescedChange,
  ViteHMRPayload,
  HMRReplayEnvelope,
} from "./hmr-types";
import { MAX_REPLAY_BUFFER, REPLAY_MAX_AGE_MS } from "./hmr-types";
import path from "path";
import fs from "fs";

/**
 * #184: 공통 디렉토리 변경 시 사용하는 sentinel.
 * `onSSRChange`에 특정 파일 경로 대신 이 상수를 전달하면 "전체 SSR 레지스트리 invalidate" 의미.
 */
export const SSR_CHANGE_WILDCARD = "*";

export interface DevBundlerOptions {
  /** 프로젝트 루트 */
  rootDir: string;
  /** 라우트 매니페스트 */
  manifest: RoutesManifest;
  /** 재빌드 콜백 */
  onRebuild?: (result: RebuildResult) => void;
  /** 에러 콜백 */
  onError?: (error: Error, routeId?: string) => void;
  /**
   * SSR 파일 변경 콜백 (page.tsx, layout.tsx 등)
   * 클라이언트 번들 리빌드 없이 서버 핸들러 재등록이 필요한 경우 호출.
   * `SSR_CHANGE_WILDCARD` ("*")를 받으면 전체 레지스트리 invalidate 의미 (#184).
   * Promise 반환 시 await 되므로 레지스트리 clear가 완료된 후 HMR reload broadcast 가능.
   */
  onSSRChange?: (filePath: string) => void | Promise<void>;
  /**
   * API route 파일 변경 콜백 (route.ts 등)
   * API 핸들러 재등록이 필요한 경우 호출
   */
  onAPIChange?: (filePath: string) => void | Promise<void>;
  /**
   * 추가 watch 디렉토리 (공통 컴포넌트 등)
   * 상대 경로 또는 절대 경로 모두 지원
   * 기본값: ["src/components", "components", "src/shared", "shared", "src/lib", "lib", "src/hooks", "hooks", "src/utils", "utils"]
   */
  watchDirs?: string[];
  /**
   * 기본 watch 디렉토리 비활성화
   * true로 설정하면 watchDirs만 감시
   */
  disableDefaultWatchDirs?: boolean;
}

export interface RebuildResult {
  routeId: string;
  success: boolean;
  buildTime: number;
  error?: string;
}

export interface DevBundler {
  /** 초기 빌드 결과 */
  initialBuild: BundleResult;
  /** 파일 감시 중지 */
  close: () => void;
}

/**
 * #180: 파일 경로 비교를 위한 정규화.
 * - 절대 경로로 변환 (path.resolve)
 * - 백슬래시 → 포워드슬래시
 * - Windows에서는 case-insensitive 매칭 (소문자화)
 *
 * 동적 라우트 폴더(`[lang]` 등) 변경 감지가 누락되던 문제는 watcher가 보고하는
 * `path.join(dir, filename)`과 `serverModuleSet` 등록 시의 `path.resolve(rootDir, ...)`
 * 가 드라이브 문자 대소문자/슬래시 표기 차이로 어긋나서 발생했음.
 */
function normalizeFsPath(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 기본 공통 컴포넌트 디렉토리 목록 (B1 fix — Phase 7.0 R1 Agent A).
 *
 * Historical (pre-B1) behavior: only `src/components`, `src/shared`, etc. were
 * watched, which silently ignored `src/foo.ts` (top-level files) — a real
 * regression hit in `demo/starter/src/playground-shell.tsx`. B1 widens the
 * default to include **`src/` itself** (recursive, node_modules-excluded) plus
 * the legacy unprefixed roots so existing projects without an `src/` dir
 * continue to work.
 */
const DEFAULT_COMMON_DIRS = [
  "src",                // B1 fix — top-level files under `src/` (was missing)
  "components",
  "shared",
  "lib",
  "hooks",
  "utils",
  "client",
  "islands",
];

/**
 * Path segments excluded from `isInCommonDir` / watcher dispatch.
 *
 * We intentionally use **absolute path segment prefixes** (join-style) so a
 * project file named `dist-nice.ts` is NOT treated as excluded. The check is
 * "contains `/<segment>/`" against the normalized forward-slash path.
 *
 * `pagefile.sys` / `hiberfil.sys` / `DumpStack.log.tmp` are Windows system
 * files that can bubble up into `fs.watch` on the drive root under pathological
 * setups — belt-and-suspenders.
 */
const WATCH_EXCLUDE_SEGMENTS: readonly string[] = [
  "node_modules",
  ".mandu",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
];

/**
 * Filenames explicitly ignored (Windows system files + editor artifacts).
 *
 * Stored lowercase so the check compares apples-to-apples with
 * `normalizeFsPath`'s win32 lowercasing. On posix the comparison is still
 * lowercase — intentional, since the Windows system files these target
 * never legitimately appear on Linux/mac anyway.
 */
const WATCH_EXCLUDE_FILENAMES: ReadonlySet<string> = new Set([
  "pagefile.sys",
  "hiberfil.sys",
  "dumpstack.log",
  "dumpstack.log.tmp",
  "swapfile.sys",
]);

/**
 * Returns true if the given **normalized (forward-slash, lowercase on win32)**
 * path is inside a directory we should ignore (e.g. `node_modules`).
 *
 * Callers must pass paths already through `normalizeFsPath`.
 */
export function isExcludedPath(normalizedPath: string): boolean {
  // Filename-level ignores. We lowercase the basename BEFORE comparing so the
  // check behaves identically whether the caller ran `normalizeFsPath` (which
  // lowercases only on win32) or not — Windows system files like
  // `DumpStack.log` have no valid posix counterpart, so lowercasing is safe
  // on linux too.
  const basename = (normalizedPath.split("/").pop() ?? "").toLowerCase();
  if (WATCH_EXCLUDE_FILENAMES.has(basename)) return true;

  // Directory-segment ignores. Wrap with slashes to avoid partial-name matches
  // (e.g. `dist-ribution.ts` must not be excluded by `dist`).
  for (const segment of WATCH_EXCLUDE_SEGMENTS) {
    if (normalizedPath.includes(`/${segment}/`)) return true;
  }
  return false;
}

/**
 * Test-only helper: invoke the internal `normalizeFsPath` implementation.
 * Exported so `dev-reliability.test.ts` can assert forward-slash / lower-case
 * normalization without duplicating the logic.
 *
 * Not part of the public API surface — prefixed with `_testOnly_` to signal
 * "do not consume in production code". If you need this elsewhere, lift
 * `normalizeFsPath` to a dedicated module.
 */
export function _testOnly_normalizeFsPath(p: string): string {
  return normalizeFsPath(p);
}

/** Test-only accessor for the default common-dir list (B1 coverage). */
export const _testOnly_DEFAULT_COMMON_DIRS = DEFAULT_COMMON_DIRS;

/** Test-only accessor for the watch exclude segments (B1 coverage). */
export const _testOnly_WATCH_EXCLUDE_SEGMENTS = WATCH_EXCLUDE_SEGMENTS;

/**
 * 개발 모드 번들러 시작
 * 파일 변경 감시 및 자동 재빌드
 */
export async function startDevBundler(options: DevBundlerOptions): Promise<DevBundler> {
  const {
    rootDir,
    manifest,
    onRebuild,
    onError,
    onSSRChange,
    onAPIChange,
    watchDirs: customWatchDirs = [],
    disableDefaultWatchDirs = false,
  } = options;

  // 초기 빌드
  console.log("🔨 Initial client bundle build...");
  const initialBuild = await buildClientBundles(manifest, rootDir, {
    minify: false,
    sourcemap: true,
  });

  if (initialBuild.success) {
    console.log(`✅ Built ${initialBuild.stats.bundleCount} islands`);
  } else {
    console.error("⚠️  Initial build had errors:", initialBuild.errors);
  }

  // clientModule 경로에서 routeId 매핑 생성
  const clientModuleToRoute = new Map<string, string>();
  const serverModuleSet = new Set<string>(); // SSR 모듈 (page.tsx, layout.tsx)
  const apiModuleSet = new Set<string>(); // API 모듈 (route.ts)
  const watchDirs = new Set<string>();
  const commonWatchDirs = new Set<string>(); // 공통 디렉토리 (전체 재빌드 트리거)

  for (const route of manifest.routes) {
    if (route.clientModule) {
      const absPath = path.resolve(rootDir, route.clientModule);
      const normalizedPath = normalizeFsPath(absPath);
      clientModuleToRoute.set(normalizedPath, route.id);

      // Also register *.client.tsx/ts files in the same directory (#140)
      // e.g. if clientModule is app/page.island.tsx, also map app/page.client.tsx → same routeId
      const dir = path.dirname(absPath);
      const baseStem = path.basename(absPath).replace(/\.(island|client)\.(tsx?|jsx?)$/, "");
      for (const ext of [".client.tsx", ".client.ts", ".client.jsx", ".client.js"]) {
        const clientPath = normalizeFsPath(path.join(dir, baseStem + ext));
        if (clientPath !== normalizedPath) {
          clientModuleToRoute.set(clientPath, route.id);
        }
      }

      // 감시할 디렉토리 추가
      watchDirs.add(dir);
    }

    // SSR 모듈 등록 (page.tsx, layout.tsx) — #151
    if (route.componentModule) {
      const absPath = path.resolve(rootDir, route.componentModule);
      serverModuleSet.add(normalizeFsPath(absPath));
      watchDirs.add(path.dirname(absPath));
    }
    if (route.layoutChain) {
      for (const layoutPath of route.layoutChain) {
        const absPath = path.resolve(rootDir, layoutPath);
        serverModuleSet.add(normalizeFsPath(absPath));
        watchDirs.add(path.dirname(absPath));
      }
    }

    // Track API route modules for hot-reload
    if (route.kind === "api" && route.module) {
      const absPath = path.resolve(rootDir, route.module);
      apiModuleSet.add(normalizeFsPath(absPath));
      watchDirs.add(path.dirname(absPath));
    }
  }

  // spec/slots 디렉토리도 추가
  const slotsDir = path.join(rootDir, "spec", "slots");
  try {
    await fs.promises.access(slotsDir);
    watchDirs.add(slotsDir);
  } catch {
    // slots 디렉토리 없으면 무시
  }

  // 공통 컴포넌트 디렉토리 추가 (기본 + 커스텀)
  const commonDirsToCheck = disableDefaultWatchDirs
    ? customWatchDirs
    : [...DEFAULT_COMMON_DIRS, ...customWatchDirs];

  const addCommonDir = async (dir: string): Promise<void> => {
    const absPath = path.isAbsolute(dir) ? dir : path.join(rootDir, dir);
    try {
      const stat = await fs.promises.stat(absPath);
      const watchPath = stat.isDirectory() ? absPath : path.dirname(absPath);
      await fs.promises.access(watchPath);
      commonWatchDirs.add(watchPath);
      watchDirs.add(watchPath);
    } catch {
      // 디렉토리 없으면 무시
    }
  };

  for (const dir of commonDirsToCheck) {
    await addCommonDir(dir);
  }

  // 파일 감시 설정
  const watchers: fs.FSWatcher[] = [];

  /**
   * B6 fix — per-file debounce Map (Phase 7.0 R1 Agent A).
   *
   * Pre-B6 behavior: a single module-scope `debounceTimer` was cleared on EVERY
   * fs event. Two rapid events on different files within `WATCHER_DEBOUNCE`
   * (100 ms) therefore dropped the earlier one. B6 gives each file its own
   * timer so an edit to file A does not cancel a pending edit to file B.
   *
   * Lifecycle: timers are created by `scheduleFileChange`, cleared on flush or
   * on `close()`. We call `.delete(key)` on flush to keep the Map bounded —
   * no leak from editing a single file repeatedly.
   */
  const perFileTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * B2 fix — multi-file pending build queue (Phase 7.0 R1 Agent A).
   *
   * Pre-B2 behavior: `pendingBuildFile: string | null` — the second and third
   * rapid-fire changes overwrote each other and were silently dropped. B2 uses
   * a Set so EVERY changed file during an in-flight build is retained and
   * flushed together after completion. Coalesce by `kind` to issue at most one
   * `buildClientBundles` call per batch when possible.
   */
  const pendingBuildSet = new Set<string>();

  // 동시 빌드 방지 (#121): 빌드 중에 변경 발생 시 다음 빌드 대기
  let isBuilding = false;

  /**
   * Paths already known to be inside a common directory, cached to avoid
   * repeating prefix checks for noisy watchers (IDE autosave bursts).
   */
  const isInCommonDir = (filePath: string): boolean => {
    const normalizedFile = normalizeFsPath(filePath);
    for (const commonDir of commonWatchDirs) {
      const normalizedCommon = normalizeFsPath(commonDir);
      if (
        normalizedFile === normalizedCommon ||
        normalizedFile.startsWith(normalizedCommon + "/")
      ) {
        return true;
      }
    }
    return false;
  };

  /**
   * Classify a batched `Set` of changed files for B2 coalescing.
   *
   * Kept simple on purpose — `_doBuild` downstream re-checks fine-grained
   * routing (clientModule / serverModule / API), so we only need the coarse
   * category used by the hmr-types contract.
   */
  const classifyBatch = (files: readonly string[]): CoalescedChange["kind"] => {
    let hasCommon = false;
    let hasSsr = false;
    let hasApi = false;
    let hasIsland = false;
    let hasCss = false;

    for (const file of files) {
      const normalized = normalizeFsPath(file);
      if (normalized.endsWith(".css")) {
        hasCss = true;
        continue;
      }
      if (isInCommonDir(file)) {
        hasCommon = true;
        continue;
      }
      if (apiModuleSet.has(normalized)) {
        hasApi = true;
        continue;
      }
      if (serverModuleSet.has(normalized)) {
        hasSsr = true;
        continue;
      }
      if (clientModuleToRoute.has(normalized)) {
        hasIsland = true;
        continue;
      }
      if (
        file.endsWith(".client.ts") ||
        file.endsWith(".client.tsx") ||
        file.endsWith(".island.tsx") ||
        file.endsWith(".island.ts")
      ) {
        hasIsland = true;
      }
    }

    // Common-dir dominates — it already fans out to every island + SSR
    // registry. No point in double-classifying "mixed" when a fan-out fix
    // obsoletes the individual changes.
    if (hasCommon) return "common-dir";

    const categories = [hasSsr, hasApi, hasIsland, hasCss].filter(Boolean).length;
    if (categories === 0) return "mixed";
    if (categories > 1) return "mixed";
    if (hasSsr) return "ssr-only";
    if (hasApi) return "api-only";
    if (hasIsland) return "islands-only";
    if (hasCss) return "css-only";
    return "mixed";
  };

  /**
   * Flush the pending build queue as a single coalesced batch. Prefers a
   * common-dir path when any file in the batch triggers one — that already
   * fans out to every island + SSR registry invalidation, so processing the
   * other files individually would be wasted work.
   *
   * Called by `handleFileChange`'s retry loop when `pendingBuildSet` is
   * non-empty; also safe to call directly from watchers if the queue contract
   * evolves.
   */
  const flushPendingBatch = async (): Promise<void> => {
    if (pendingBuildSet.size === 0) return;
    const files = Array.from(pendingBuildSet);
    pendingBuildSet.clear();

    const kind = classifyBatch(files);

    // Common-dir dominates: one full-reload-adjacent rebuild covers everyone.
    if (kind === "common-dir") {
      await handleFileChange(files.find((f) => isInCommonDir(f)) ?? files[0]);
      return;
    }

    // Otherwise fan out. Each individual handleFileChange is idempotent —
    // if someone edits 4 siblings the build semaphore serializes them, but
    // none is dropped.
    for (const file of files) {
      try {
        await handleFileChange(file);
      } catch (retryError) {
        console.error(
          "[Mandu HMR] batch flush error:",
          retryError instanceof Error ? retryError.message : String(retryError),
        );
      }
    }
  };

  const handleFileChange = async (changedFile: string): Promise<void> => {
    // 동시 빌드 방지 (#121) — B2 강화: 빌드 중이면 Set에 추가 (drop 방지).
    if (isBuilding) {
      pendingBuildSet.add(changedFile);
      return;
    }

    isBuilding = true;
    mark("dev:rebuild");
    mark(HMR_PERF.REBUILD_TOTAL);
    try {
      await _doBuild(changedFile);
    } finally {
      measure("dev:rebuild", "dev:rebuild");
      measure(HMR_PERF.REBUILD_TOTAL, HMR_PERF.REBUILD_TOTAL);
      isBuilding = false;
      // B2: 대기 중인 모든 파일을 batch로 flush.
      if (pendingBuildSet.size > 0) {
        try {
          await flushPendingBatch();
        } catch (retryError) {
          console.error(
            `❌ Retry build error:`,
            retryError instanceof Error ? retryError.message : String(retryError),
          );
          console.log(`   ⏳ Waiting for next file change to retry...`);
        }
      }
    }
  };

  /**
   * Per-file debounce scheduler (B6 fix).
   *
   * Creates or restarts ONE timer keyed by the normalized path. The timer
   * fires `handleFileChange` after `WATCHER_DEBOUNCE` quiet time. If the same
   * file fires again within the window, we reset only that file's timer — a
   * second file keeps its own timeline.
   *
   * Errors from the scheduled handler are caught here to prevent an
   * unhandled promise rejection from killing the watcher loop (#10).
   */
  const scheduleFileChange = (fullPath: string): void => {
    const key = normalizeFsPath(fullPath);
    const existing = perFileTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      perFileTimers.delete(key);
      mark(HMR_PERF.DEBOUNCE_FLUSH);
      measure(HMR_PERF.DEBOUNCE_FLUSH, HMR_PERF.DEBOUNCE_FLUSH);
      handleFileChange(fullPath).catch((err) => {
        console.error(
          "[Mandu HMR] file-change handler error:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }, TIMEOUTS.WATCHER_DEBOUNCE);

    perFileTimers.set(key, timer);
  };

  const _doBuild = async (changedFile: string) => {
    const normalizedPath = normalizeFsPath(changedFile);

    // 공통 컴포넌트 디렉토리 변경 → Island만 재빌드 + SSR 레지스트리 invalidate (#184, #185)
    if (isInCommonDir(changedFile)) {
      console.log(`\n🔄 Common file changed: ${path.basename(changedFile)}`);
      console.log(`   Rebuilding islands (framework bundles skipped)...`);
      const startTime = performance.now();

      try {
        // #185: framework 번들 (runtime/router/vendor/devtools) 스킵 — 사용자 코드 변경 시 불필요
        const result = await buildClientBundles(manifest, rootDir, {
          minify: false,
          sourcemap: true,
          skipFrameworkBundles: true,
        });

        const buildTime = performance.now() - startTime;

        if (result.success) {
          // #184: common dir 변경은 SSR 모듈 캐시 invalidation이 필요 — wildcard 시그널
          // 빌드 성공한 경우에만 SSR 레지스트리를 clear (실패 시 마지막 good state 유지)
          // 주의: Bun의 transitive ESM 캐시는 프로세스 레벨이라 이 시그널만으로는
          //      `src/shared/**`을 transitive하게 import하는 SSR 모듈까지 완전히 갱신되지 않음.
          //      진짜 해결은 subprocess/worker 기반 SSR eval이 필요 (follow-up 이슈).
          if (onSSRChange) {
            try {
              await Promise.resolve(onSSRChange(SSR_CHANGE_WILDCARD));
            } catch (ssrError) {
              console.warn(`⚠️  SSR invalidation failed:`, ssrError instanceof Error ? ssrError.message : ssrError);
            }
          }

          console.log(`✅ Rebuilt ${result.stats.bundleCount} islands in ${buildTime.toFixed(0)}ms`);
          onRebuild?.({
            routeId: "*", // 전체 재빌드 표시
            success: true,
            buildTime,
          });
        } else {
          console.error(`❌ Build failed:`, result.errors);
          console.log(`   ⏳ SSR registry not invalidated (keeping last good state)`);
          onRebuild?.({
            routeId: "*",
            success: false,
            buildTime,
            error: result.errors.join(", "),
          });
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`❌ Build error:`, err.message);
        console.log(`   ⏳ Waiting for next file change to retry...`);
        onError?.(err, "*");
      }
      return;
    }

    // clientModule 매핑에서 routeId 찾기
    let routeId = clientModuleToRoute.get(normalizedPath);

    // Fallback for *.client.tsx/ts: find route whose clientModule is in the same directory (#140)
    // basename matching (e.g. "page" !== "index") is unreliable — use directory-based matching instead
    if (!routeId && (changedFile.endsWith(".client.ts") || changedFile.endsWith(".client.tsx"))) {
      const changedDir = normalizeFsPath(path.dirname(path.resolve(rootDir, changedFile)));
      const matchedRoute = manifest.routes.find((r) => {
        if (!r.clientModule) return false;
        const routeDir = normalizeFsPath(path.dirname(path.resolve(rootDir, r.clientModule)));
        return routeDir === changedDir;
      });
      if (matchedRoute) {
        routeId = matchedRoute.id;
      }
    }

    if (!routeId) {
      // SSR 모듈 변경 감지 (page.tsx, layout.tsx) — #151
      if (onSSRChange && serverModuleSet.has(normalizedPath)) {
        console.log(`\n🔄 SSR file changed: ${path.basename(changedFile)}`);
        onSSRChange(normalizedPath);
        return;
      }
      // API 모듈 변경 감지 (route.ts)
      if (onAPIChange && apiModuleSet.has(normalizedPath)) {
        console.log(`\n🔄 API route changed: ${path.basename(changedFile)}`);
        onAPIChange(normalizedPath);
      }
      return;
    }

    const route = manifest.routes.find((r) => r.id === routeId);
    if (!route || !route.clientModule) return;

    console.log(`\n🔄 Rebuilding island: ${routeId}`);
    const startTime = performance.now();

    try {
      // 단일 island만 재빌드 (Runtime/Router/Vendor 스킵, #122)
      const result = await buildClientBundles(manifest, rootDir, {
        minify: false,
        sourcemap: true,
        targetRouteIds: [routeId],
      });

      const buildTime = performance.now() - startTime;

      if (result.success) {
        console.log(`✅ Rebuilt in ${buildTime.toFixed(0)}ms`);
        onRebuild?.({
          routeId,
          success: true,
          buildTime,
        });
      } else {
        console.error(`❌ Build failed:`, result.errors);
        console.log(`   ⏳ Previous bundle preserved. Waiting for next file change to retry...`);
        onRebuild?.({
          routeId,
          success: false,
          buildTime,
          error: result.errors.join(", "),
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`❌ Build error:`, err.message);
      console.log(`   ⏳ Previous bundle preserved. Waiting for next file change to retry...`);
      onError?.(err, routeId);
    }
  };

  // 각 디렉토리에 watcher 설정 — B1/B6 fix
  for (const dir of watchDirs) {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
        if (!filename) return;

        // TypeScript/TSX 파일만 감시
        if (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) return;

        const fullPath = path.join(dir, filename);

        // B1 fix — exclude `node_modules`, `.mandu`, `dist`, `build`, OS files.
        // Must run on the FULL path (filename alone loses directory context when
        // `recursive:true` reports a deep subpath).
        const normalizedFull = normalizeFsPath(fullPath);
        if (isExcludedPath(normalizedFull)) return;

        mark(HMR_PERF.FILE_DETECT);
        measure(HMR_PERF.FILE_DETECT, HMR_PERF.FILE_DETECT);

        // B6 fix — per-file debounce (replaces global single timer).
        scheduleFileChange(fullPath);
      });

      watchers.push(watcher);
    } catch {
      console.warn(`⚠️  Cannot watch directory: ${dir}`);
    }
  }

  if (watchers.length > 0) {
    console.log(`👀 Watching ${watchers.length} directories for changes...`);
    if (commonWatchDirs.size > 0) {
      const commonDirNames = Array.from(commonWatchDirs)
        .map(d => (path.relative(rootDir, d) || ".").replace(/\\/g, "/"))
        .join(", ");
      console.log(`📦 Common dirs (full rebuild): ${commonDirNames}`);
    }
  }

  return {
    initialBuild,
    close: () => {
      // B6: clear all per-file timers to release event-loop refs.
      for (const timer of perFileTimers.values()) {
        clearTimeout(timer);
      }
      perFileTimers.clear();
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}

/**
 * HMR WebSocket 서버
 *
 * Phase 7.0 R1 Agent C: added replay buffer (B8), Vite-compat wire format
 * broadcast, and `?since=<id>` reconnect handshake. The classic
 * `broadcast(HMRMessage)` API is kept for existing callers; a second
 * `broadcastVite(ViteHMRPayload)` channel serves external devtools that
 * speak the Vite HMR WebSocket protocol.
 */
export interface HMRServer {
  /** 연결된 클라이언트 수 */
  clientCount: number;
  /** 모든 클라이언트에게 메시지 전송 — 내부 Mandu 포맷. */
  broadcast: (message: HMRMessage) => void;
  /**
   * Broadcast a Vite-compat HMR payload. The payload is queued in the
   * replay buffer so reconnecting clients can resume with `?since=<id>`
   * and does not need a Mandu-side wrapper shape. External devtools
   * that speak the Vite HMR protocol consume this directly.
   */
  broadcastVite: (payload: ViteHMRPayload) => HMRReplayEnvelope;
  /** 서버 중지 */
  close: () => void;
  /** 재시작 핸들러 등록 */
  setRestartHandler: (handler: () => Promise<void>) => void;
  /**
   * Diagnostics accessor — current replay-buffer length and the last
   * broadcast envelope id. Exposed for unit tests; production code
   * should use `broadcast` / `broadcastVite`.
   */
  _inspectReplayBuffer: () => { size: number; lastId: number; oldestId: number | null };
}

export interface HMRMessage {
  type:
    | "connected"
    | "reload"
    | "full-reload"              // Phase 7.0 — Vite-compat escalation path
    | "update"                   // Phase 7.0 — granular update (js / css)
    | "invalidate"               // Phase 7.0 — module requested full reload
    | "island-update"
    | "layout-update"
    | "css-update"
    | "error"
    | "ping"
    | "guard-violation"
    | "kitchen:file-change"
    | "kitchen:guard-decision";
  data?: {
    routeId?: string;
    layoutPath?: string;
    cssPath?: string;
    message?: string;
    timestamp?: number;
    file?: string;
    violations?: Array<{ line: number; message: string }>;
    changeType?: "add" | "change" | "delete";
    action?: "approve" | "reject";
    ruleId?: string;
    /** Vite-compat updates array — populated when `type === "update"`. */
    updates?: Array<{ type: "js-update" | "css-update"; path: string; acceptedPath: string; timestamp: number }>;
    /** `full-reload` / `invalidate` optional path hint. */
    path?: string;
    /** Last rebuild id assigned by the replay buffer (if any). */
    id?: number;
  };
}

/**
 * HMR WebSocket 서버 생성
 *
 * Phase 7.0 R1 Agent C additions:
 *   - **Replay buffer (B8)**: every `broadcastVite` payload is enqueued with
 *     a monotonic `id`. Clients reconnect with `?since=<id>` and the server
 *     re-sends anything they missed. Buffer is bounded by
 *     `MAX_REPLAY_BUFFER` entries and `REPLAY_MAX_AGE_MS` age — older
 *     envelopes are pruned, and too-old `since` values trigger a
 *     `full-reload` as the safe fallback.
 *   - **Vite-compat wire format**: `broadcastVite(ViteHMRPayload)` sends
 *     the byte-equivalent of what Vite would emit, so external devtools
 *     / editor plugins that speak Vite's HMR protocol work unchanged.
 *   - **layout-update**: callers (Agent A's `onSSRChange` path) invoke
 *     `broadcast({ type: "layout-update", ... })` when a `layout.tsx`
 *     changes; the client handler forces a full reload.
 *
 * The classic `broadcast(HMRMessage)` API is preserved as the internal
 * Mandu format; both broadcast channels share the same WebSocket.
 */
export function createHMRServer(port: number): HMRServer {
  const clients = new Set<{ send: (data: string) => void; close: () => void }>();
  const hmrPort = port + PORTS.HMR_OFFSET;
  let restartHandler: (() => Promise<void>) | null = null;

  // ─── Replay buffer (B8) ────────────────────────────────────────────────
  //
  // Monotonic counter; resets to 0 on server boot (restart is a full
  // reload anyway so clients can't meaningfully resume across it).
  let lastRebuildId = 0;
  const replayBuffer: HMRReplayEnvelope[] = [];

  /** Drop envelopes older than `REPLAY_MAX_AGE_MS`. Called opportunistically. */
  const pruneOldReplays = (): void => {
    const cutoff = Date.now() - REPLAY_MAX_AGE_MS;
    // Buffer is chronological (push-only, shift-from-front), so one-pass prune.
    while (replayBuffer.length > 0 && replayBuffer[0]!.timestamp < cutoff) {
      replayBuffer.shift();
    }
  };

  /**
   * Append a Vite payload to the replay buffer. Returns the envelope
   * that was queued so the caller can inspect its id (used in tests and
   * by the `broadcast` path to echo the id into the internal message).
   */
  const enqueueReplay = (payload: ViteHMRPayload): HMRReplayEnvelope => {
    mark(HMR_PERF.HMR_REPLAY_ENQUEUE);
    lastRebuildId += 1;
    const envelope: HMRReplayEnvelope = {
      id: lastRebuildId,
      timestamp: Date.now(),
      payload,
    };
    replayBuffer.push(envelope);
    // Bound by size first (cheap), then by age (slightly more work but
    // still O(n) amortized across inserts).
    while (replayBuffer.length > MAX_REPLAY_BUFFER) {
      replayBuffer.shift();
    }
    pruneOldReplays();
    measure(HMR_PERF.HMR_REPLAY_ENQUEUE, HMR_PERF.HMR_REPLAY_ENQUEUE);
    return envelope;
  };

  /**
   * Parse `?since=<id>` from the upgrade URL. Returns `null` for missing
   * or malformed values (negative / non-numeric / NaN). Treating a
   * malformed value as `null` is the safe choice — the client simply
   * gets the default `connected` handshake.
   */
  const parseSince = (url: URL): number | null => {
    const raw = url.searchParams.get("since");
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  };

  /**
   * Handle the post-upgrade replay flush. The three branches:
   *
   *   1. `since === null` → new client, send `connected` only.
   *   2. `since >= lastRebuildId` → client is already current, send
   *      `connected` and nothing else.
   *   3. `since < oldestId` → client missed more than the buffer holds,
   *      force a `full-reload`.
   *   4. otherwise → re-send every envelope with `id > since`.
   *
   * The caller (WS `open` handler) only knows the raw `since`; we do
   * the dispatch here so the logic stays co-located with the buffer.
   */
  const flushReplayToClient = (
    ws: { send: (data: string) => void },
    since: number | null,
  ): void => {
    if (since === null) {
      ws.send(
        JSON.stringify({ type: "connected", data: { timestamp: Date.now(), id: lastRebuildId } }),
      );
      return;
    }
    // Already caught up — nothing to replay but still greet.
    if (since >= lastRebuildId) {
      ws.send(
        JSON.stringify({ type: "connected", data: { timestamp: Date.now(), id: lastRebuildId } }),
      );
      return;
    }
    pruneOldReplays();
    const oldestId = replayBuffer.length > 0 ? replayBuffer[0]!.id : null;
    if (oldestId === null || since < oldestId) {
      // Missed too much — force a full reload.
      mark(HMR_PERF.HMR_REPLAY_FLUSH);
      ws.send(
        JSON.stringify({
          type: "full-reload",
          data: { timestamp: Date.now(), message: "replay-buffer-exhausted" },
        }),
      );
      measure(HMR_PERF.HMR_REPLAY_FLUSH, HMR_PERF.HMR_REPLAY_FLUSH);
      return;
    }
    // Replay every envelope strictly newer than `since`.
    mark(HMR_PERF.HMR_REPLAY_FLUSH);
    ws.send(
      JSON.stringify({ type: "connected", data: { timestamp: Date.now(), id: lastRebuildId } }),
    );
    for (const env of replayBuffer) {
      if (env.id <= since) continue;
      // Wrap in a thin envelope so the client can see the id; keep the
      // Vite payload verbatim for external consumers.
      ws.send(
        JSON.stringify({
          type: "vite-replay",
          data: { id: env.id, timestamp: env.timestamp },
          payload: env.payload,
        }),
      );
    }
    measure(HMR_PERF.HMR_REPLAY_FLUSH, HMR_PERF.HMR_REPLAY_FLUSH);
  };

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": `http://localhost:${port}`,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Type parameter carries the `?since=<id>` value from the upgrade
  // request to the WebSocket `open` handler via Bun's per-connection
  // data slot. Without the generic, `server.upgrade(req, { data })`
  // types `data` as `undefined` — Bun.serve has no runtime inference.
  interface WSData {
    since: number | null;
  }

  const server = Bun.serve<WSData, never>({
    port: hmrPort,
    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // POST /restart → 재시작 핸들러 호출
      if (req.method === "POST" && url.pathname === "/restart") {
        if (!restartHandler) {
          return new Response(
            JSON.stringify({ error: "No restart handler registered" }),
            { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        try {
          console.log("🔄 Full restart requested from DevTools");
          await restartHandler();
          return new Response(
            JSON.stringify({ status: "restarted" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("❌ Restart failed:", message);
          return new Response(
            JSON.stringify({ error: message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      // WebSocket 업그레이드 — stash `since` in per-connection data so the
      // `open` handler has access to it.
      const since = parseSince(url);
      if (server.upgrade(req, { data: { since } })) {
        return;
      }

      // 일반 HTTP 요청은 상태 반환
      return new Response(
        JSON.stringify({
          status: "ok",
          clients: clients.size,
          port: hmrPort,
          lastRebuildId,
          replayBufferSize: replayBuffer.length,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        // `since` is attached by the upgrade handler (typed via WSData).
        // It's `null` when the client didn't supply `?since=` (new tab).
        const since = ws.data?.since ?? null;
        flushReplayToClient(ws, since);
      },
      close(ws) {
        clients.delete(ws);
      },
      message(ws, message) {
        // 클라이언트로부터의 ping 처리 + invalidate 수신.
        try {
          const data = JSON.parse(String(message));
          if (data.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", data: { timestamp: Date.now() } }));
            return;
          }
          if (data.type === "invalidate") {
            // A module called `import.meta.hot.invalidate()` in the
            // browser. Phase 7.0 v0.1 response: escalate to full reload
            // on the module that invalidated. Broadcasting through
            // `broadcastVite` puts it in the replay buffer too so other
            // tabs observe the same reload.
            const path =
              typeof data.moduleUrl === "string" ? data.moduleUrl : undefined;
            const payload: ViteHMRPayload = { type: "full-reload", path };
            const envelope = enqueueReplay(payload);
            const wire = JSON.stringify({
              type: "full-reload",
              data: {
                timestamp: envelope.timestamp,
                id: envelope.id,
                path,
                message:
                  typeof data.message === "string" ? data.message : undefined,
              },
            });
            for (const client of clients) {
              try {
                client.send(wire);
              } catch {
                clients.delete(client);
              }
            }
          }
        } catch {
          // 무시 — malformed JSON from the client is never fatal.
        }
      },
    },
  });

  console.log(`🔥 HMR server running on ws://localhost:${hmrPort}`);

  /**
   * Send a payload string to every connected client, pruning dead
   * sockets as a side effect. Factored out so `broadcast` and
   * `broadcastVite` share the fan-out loop exactly.
   */
  const fanout = (payload: string): void => {
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  return {
    get clientCount() {
      return clients.size;
    },
    broadcast: (message: HMRMessage) => {
      mark(HMR_PERF.HMR_BROADCAST);
      // For message types that map to a Vite payload, enqueue a replay
      // envelope so reconnecting clients also see the event. The mapping
      // is conservative — only canonical cases get queued; devtools and
      // guard-violation events are ephemeral.
      let envelopeId: number | undefined;
      if (message.type === "reload" || message.type === "full-reload") {
        const envelope = enqueueReplay({ type: "full-reload", path: message.data?.path });
        envelopeId = envelope.id;
      } else if (message.type === "island-update" || message.type === "layout-update") {
        // These are Mandu-internal shapes; record a generic `update`
        // envelope so reconnecting clients at least know something
        // changed. Full-fidelity replay of Mandu messages is intentional
        // future work — we'd need a second buffer per payload shape.
        const envelope = enqueueReplay({
          type: "update",
          updates: [
            {
              type: "js-update",
              path: message.data?.layoutPath ?? message.data?.routeId ?? "?",
              acceptedPath: message.data?.layoutPath ?? message.data?.routeId ?? "?",
              timestamp: Date.now(),
            },
          ],
        });
        envelopeId = envelope.id;
      } else if (message.type === "css-update") {
        const envelope = enqueueReplay({
          type: "update",
          updates: [
            {
              type: "css-update",
              path: message.data?.cssPath ?? "/.mandu/client/globals.css",
              acceptedPath: message.data?.cssPath ?? "/.mandu/client/globals.css",
              timestamp: Date.now(),
            },
          ],
        });
        envelopeId = envelope.id;
      }

      const outgoing: HMRMessage =
        envelopeId !== undefined
          ? { ...message, data: { ...(message.data ?? {}), id: envelopeId } }
          : message;
      const payload = JSON.stringify(outgoing);
      fanout(payload);
      measure(HMR_PERF.HMR_BROADCAST, HMR_PERF.HMR_BROADCAST);
    },
    broadcastVite: (payload: ViteHMRPayload): HMRReplayEnvelope => {
      mark(HMR_PERF.HMR_BROADCAST);
      const envelope = enqueueReplay(payload);
      // Wire format: wrap with the envelope id so replayed and live
      // messages are indistinguishable on the client side. External
      // devtools that only care about the raw Vite payload can read
      // `payload` directly.
      const wire = JSON.stringify({
        type: "vite",
        data: { id: envelope.id, timestamp: envelope.timestamp },
        payload,
      });
      fanout(wire);
      measure(HMR_PERF.HMR_BROADCAST, HMR_PERF.HMR_BROADCAST);
      return envelope;
    },
    close: () => {
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // 무시
        }
      }
      clients.clear();
      server.stop();
    },
    setRestartHandler: (handler: () => Promise<void>) => {
      restartHandler = handler;
    },
    _inspectReplayBuffer: () => ({
      size: replayBuffer.length,
      lastId: lastRebuildId,
      oldestId: replayBuffer.length > 0 ? replayBuffer[0]!.id : null,
    }),
  };
}

/**
 * HMR 클라이언트 스크립트 생성
 * 브라우저에서 실행되어 HMR 서버와 연결.
 *
 * Phase 7.0 R1 Agent C additions:
 *   - **`?since=<lastSeenId>` on reconnect**: the client tracks the id of
 *     the last envelope it processed (from `data.id`). On reconnect it
 *     appends `?since=<id>` to the WS URL so the server can replay
 *     anything missed while the socket was down.
 *   - **Vite-compat payload handling**: messages of shape
 *     `{type:"vite", payload:<ViteHMRPayload>}` and `{type:"vite-replay", payload:<...>}`
 *     are dispatched through the same code path — both deliver a Vite
 *     update wrapped with an envelope id.
 *   - **`full-reload` type**: emitted when a module invalidates or the
 *     replay buffer is exhausted; force a full page reload.
 *   - **`layout-update`**: unchanged behavior (full reload) — the server
 *     now actually broadcasts this (A's `onSSRChange` path).
 *   - **`import.meta.hot.invalidate()` upstream channel**: the runtime
 *     calls into `window.__MANDU_HMR_SEND__({type:"invalidate", moduleUrl})`
 *     which we forward on the socket. This is the only place the client
 *     sends non-ping frames.
 *   - **Vite event dispatch**: `vite:beforeUpdate` fires before an
 *     `update` or `vite` payload is applied; `vite:afterUpdate` after;
 *     `vite:beforeFullReload` before `full-reload`; `vite:error` for
 *     errors. Listeners are registered in `ManduHot.on()` (runtime).
 */
export function generateHMRClientScript(port: number): string {
  const hmrPort = port + PORTS.HMR_OFFSET;

  return `
(function() {
  window.__MANDU_HMR_PORT__ = ${hmrPort};
  const HMR_PORT = ${hmrPort};
  let ws = null;
  let reconnectAttempts = 0;
  // Last envelope id we successfully applied. Used in the ?since= query
  // on reconnect. Starts at 0 (means "no envelopes seen"); the server
  // interprets 0 as "replay everything that's still in the buffer".
  let lastSeenId = 0;
  const maxReconnectAttempts = ${TIMEOUTS.HMR_MAX_RECONNECT};
  const reconnectDelay = ${TIMEOUTS.HMR_RECONNECT_DELAY};
  const staleIslands = new Set();

  // Vite-compat event listeners. Registered by the runtime hmr-client.ts
  // via \`window.__MANDU_HMR_EVENT__(event, cb)\`; we fan out here because
  // dispatchEvent() in the runtime walks every module's listener set,
  // which the client script cannot directly import.
  const viteListeners = Object.create(null);
  window.__MANDU_HMR_EVENT__ = function(event, cb) {
    if (!viteListeners[event]) viteListeners[event] = new Set();
    viteListeners[event].add(cb);
    return function off() {
      if (viteListeners[event]) viteListeners[event].delete(cb);
    };
  };
  function fireViteEvent(event, payload) {
    var set = viteListeners[event];
    if (!set) return;
    set.forEach(function(cb) {
      try { cb(payload); } catch (e) { console.error('[Mandu HMR]', event, 'listener threw:', e); }
    });
  }

  // Upstream channel: user code calls invalidate() in the runtime, which
  // asks the client script to push a message back to the server.
  window.__MANDU_HMR_SEND__ = function(payload) {
    if (ws && ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (e) {
        console.error('[Mandu HMR] send failed:', e);
      }
    }
  };

  function connect() {
    try {
      var qs = lastSeenId > 0 ? '?since=' + lastSeenId : '';
      ws = new WebSocket('ws://' + window.location.hostname + ':' + HMR_PORT + '/' + qs);

      ws.onopen = function() {
        console.log('[Mandu HMR] Connected' + (lastSeenId > 0 ? ' (since ' + lastSeenId + ')' : ''));
        reconnectAttempts = 0;
      };

      ws.onmessage = function(event) {
        try {
          const message = JSON.parse(event.data);
          handleMessage(message);
        } catch (e) {
          console.error('[Mandu HMR] Invalid message:', e);
        }
      };

      ws.onclose = function() {
        console.log('[Mandu HMR] Disconnected');
        scheduleReconnect();
      };

      ws.onerror = function(error) {
        console.error('[Mandu HMR] Error:', error);
      };
    } catch (error) {
      console.error('[Mandu HMR] Connection failed:', error);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      var delay = Math.min(reconnectDelay * Math.pow(2, reconnectAttempts - 1), 30000);
      console.log('[Mandu HMR] Reconnecting in ' + delay + 'ms (' + reconnectAttempts + '/' + maxReconnectAttempts + ')');
      setTimeout(connect, delay);
    }
  }

  /**
   * Update lastSeenId from a message's envelope id. Only accept
   * monotonically increasing values so out-of-order replay (shouldn't
   * happen, but be defensive) can't move us backwards.
   */
  function recordEnvelopeId(message) {
    var id = message && message.data && message.data.id;
    if (typeof id === 'number' && id > lastSeenId) lastSeenId = id;
  }

  function applyViteUpdate(payload) {
    // payload is a ViteHMRPayload shape. Phase 7.0 v0.1 handles 'update'
    // as a CSS swap for the css-update sub-type and falls back to a
    // full reload for js-update (until Fast Refresh lands). 'full-reload'
    // / 'error' / 'connected' are handled inline.
    if (!payload || !payload.type) return;
    switch (payload.type) {
      case 'connected':
        // Already greeted inline; nothing else to do.
        return;
      case 'update':
        fireViteEvent('vite:beforeUpdate', payload);
        if (Array.isArray(payload.updates)) {
          for (var i = 0; i < payload.updates.length; i++) {
            var u = payload.updates[i];
            if (u.type === 'css-update') {
              // Re-timestamp any matching <link>.
              var links = document.querySelectorAll('link[rel="stylesheet"]');
              links.forEach(function(link) {
                var href = link.getAttribute('href') || '';
                var baseHref = href.split('?')[0];
                if (baseHref === u.path || href.includes('.mandu/client')) {
                  link.setAttribute('href', baseHref + '?t=' + Date.now());
                }
              });
            }
          }
        }
        fireViteEvent('vite:afterUpdate', payload);
        return;
      case 'full-reload':
        fireViteEvent('vite:beforeFullReload', payload);
        location.reload();
        return;
      case 'prune':
        // Phase 7.1+ — ignore for now.
        return;
      case 'error':
        fireViteEvent('vite:error', payload);
        if (payload.err) showErrorOverlay(payload.err.message || 'Build error');
        return;
      case 'custom':
        // Plugin custom events — route through vite:beforeUpdate namespace.
        return;
    }
  }

  function handleMessage(message) {
    // Vite-compat envelope. Two shapes: live broadcast ('vite') and
    // replayed-after-reconnect ('vite-replay'). They differ only in the
    // type tag — behavior is identical.
    if (message.type === 'vite' || message.type === 'vite-replay') {
      recordEnvelopeId(message);
      applyViteUpdate(message.payload);
      return;
    }

    switch (message.type) {
      case 'connected':
        recordEnvelopeId(message);
        console.log('[Mandu HMR] Ready');
        break;

      case 'reload':
      case 'full-reload':
        recordEnvelopeId(message);
        fireViteEvent('vite:beforeFullReload', message);
        console.log('[Mandu HMR] Full reload requested');
        location.reload();
        break;

      case 'invalidate':
        // Server echoed an invalidate — same outcome as full reload.
        recordEnvelopeId(message);
        fireViteEvent('vite:beforeFullReload', message);
        location.reload();
        break;

      case 'update':
        // Mandu-internal 'update' mirrors the Vite payload shape.
        recordEnvelopeId(message);
        applyViteUpdate({ type: 'update', updates: (message.data && message.data.updates) || [] });
        break;

      case 'island-update':
        recordEnvelopeId(message);
        const routeId = message.data?.routeId;
        console.log('[Mandu HMR] Island updated:', routeId);
        staleIslands.add(routeId);

        // 현재 페이지의 island인지 확인
        const island = document.querySelector('[data-mandu-island="' + routeId + '"]');
        if (island) {
          fireViteEvent('vite:beforeFullReload', message);
          console.log('[Mandu HMR] Reloading page for island update');
          location.reload();
        }
        break;

      case 'layout-update':
        recordEnvelopeId(message);
        const layoutPath = message.data?.layoutPath;
        console.log('[Mandu HMR] Layout updated:', layoutPath);
        fireViteEvent('vite:beforeFullReload', message);
        // Layout 변경은 항상 전체 리로드
        location.reload();
        break;

      case 'css-update':
        recordEnvelopeId(message);
        console.log('[Mandu HMR] CSS updated');
        fireViteEvent('vite:beforeUpdate', message);
        // CSS 핫 리로드 (페이지 새로고침 없이 스타일시트만 교체)
        var targetCssPath = message.data?.cssPath || '/.mandu/client/globals.css';
        var links = document.querySelectorAll('link[rel="stylesheet"]');
        links.forEach(function(link) {
          var href = link.getAttribute('href') || '';
          var baseHref = href.split('?')[0];
          // 정확한 경로 매칭 우선, fallback으로 기존 패턴 매칭
          if (baseHref === targetCssPath || href.includes('globals.css') || href.includes('.mandu/client')) {
            link.setAttribute('href', baseHref + '?t=' + Date.now());
          }
        });
        fireViteEvent('vite:afterUpdate', message);
        break;

      case 'error':
        console.error('[Mandu HMR] Build error:', message.data?.message);
        fireViteEvent('vite:error', message);
        showErrorOverlay(message.data?.message);
        break;

      case 'guard-violation':
        console.warn('[Mandu HMR] Guard violation:', message.data?.file);
        if (window.__MANDU_DEVTOOLS_HOOK__) {
          window.__MANDU_DEVTOOLS_HOOK__.emit({
            type: 'guard:violation',
            timestamp: Date.now(),
            data: message.data
          });
        }
        break;

      case 'kitchen:file-change':
        if (window.__MANDU_DEVTOOLS_HOOK__) {
          window.__MANDU_DEVTOOLS_HOOK__.emit({
            type: 'kitchen:file-change',
            timestamp: Date.now(),
            data: message.data
          });
        }
        break;

      case 'kitchen:guard-decision':
        if (window.__MANDU_DEVTOOLS_HOOK__) {
          window.__MANDU_DEVTOOLS_HOOK__.emit({
            type: 'kitchen:guard-decision',
            timestamp: Date.now(),
            data: message.data
          });
        }
        break;

      case 'pong':
        // 연결 확인
        break;
    }
  }

  function showErrorOverlay(message) {
    // 기존 오버레이 제거
    const existing = document.getElementById('mandu-hmr-error');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mandu-hmr-error';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);color:#ff6b6b;font-family:monospace;padding:40px;z-index:99999;overflow:auto;';
    const h2 = document.createElement('h2');
    h2.style.cssText = 'color:#ff6b6b;margin:0 0 20px;';
    h2.textContent = '🔥 Build Error';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;';
    pre.textContent = message || 'Unknown error';
    const btn = document.createElement('button');
    btn.style.cssText = 'position:fixed;top:20px;right:20px;background:#333;color:#fff;border:none;padding:10px 20px;cursor:pointer;';
    btn.textContent = 'Close';
    btn.onclick = function() { overlay.remove(); };
    overlay.appendChild(h2);
    overlay.appendChild(pre);
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
  }

  // 페이지 로드 시 연결
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', connect);
  } else {
    connect();
  }

  // 페이지 이탈 시 정리
  window.addEventListener('beforeunload', function() {
    if (ws) ws.close();
  });

  // 페이지 이동 시 stale island 감지 후 리로드 (#115)
  function checkStaleIslandsOnNavigation() {
    if (staleIslands.size === 0) return;
    for (const id of staleIslands) {
      if (document.querySelector('[data-mandu-island="' + id + '"]')) {
        console.log('[Mandu HMR] Stale island detected after navigation, reloading...');
        location.reload();
        return;
      }
    }
  }
  window.addEventListener('popstate', checkStaleIslandsOnNavigation);
  window.addEventListener('pageshow', function(e) {
    if (e.persisted) checkStaleIslandsOnNavigation();
  });

  // Ping 전송 (연결 유지)
  setInterval(function() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);
})();
`;
}

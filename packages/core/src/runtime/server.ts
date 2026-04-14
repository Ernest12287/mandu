import type { Server } from "bun";
import type { RoutesManifest, RouteSpec, HydrationConfig } from "../spec/schema";
import type { BundleManifest } from "../bundler/types";
import type { ManduFilling, RenderMode } from "../filling/filling";
import { ManduContext, type CookieManager } from "../filling/context";
import { Router } from "./router";
import { renderSSR, renderStreamingResponse } from "./ssr";
import {
  resolveMetadata,
  renderMetadata,
  renderTitle,
  type Metadata,
  type MetadataItem,
  type GenerateMetadata,
} from "../seo";
import { type ErrorFallbackProps } from "./boundary";
import React, { type ReactNode } from "react";
import path from "path";
import fs from "fs/promises";
import { PORTS } from "../constants";
import {
  type CacheStore,
  type CacheStoreStats,
  type CacheLookupResult,
  MemoryCacheStore,
  lookupCache,
  createCacheEntry,
  createCachedResponse,
  getCacheStoreStats,
  setGlobalCache,
} from "./cache";
import {
  createNotFoundResponse,
  createHandlerNotFoundResponse,
  createPageLoadErrorResponse,
  createSSRErrorResponse,
  errorToResponse,
  err,
  ok,
  type Result,
} from "../error";
import {
  type CorsOptions,
  isPreflightRequest,
  handlePreflightRequest,
  applyCorsToResponse,
  isCorsRequest,
} from "./cors";
import { validateImportPath } from "./security";
import { KITCHEN_PREFIX, KitchenHandler, recordRequest } from "../kitchen/kitchen-handler";
import { eventBus } from "../observability/event-bus";
import {
  type MiddlewareFn,
  type MiddlewareConfig,
  loadMiddlewareSync,
} from "./middleware";
import { createFetchHandler } from "./handler";
import { wrapBunWebSocket, type WSUpgradeData } from "../filling/ws";
import { handleImageRequest } from "./image-handler";
import { extractShellHtml, createPPRResponse } from "./ppr";

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  message?: string;
  statusCode?: number;
  headers?: boolean;
  /**
   * Reverse proxy 헤더를 신뢰할지 여부
   * - false(기본): X-Forwarded-For 등을 읽지만 spoofing 가능성을 표시
   * - true: 전달된 클라이언트 IP를 완전히 신뢰
   * 주의: trustProxy: false여도 클라이언트 구분을 위해 헤더를 사용하므로
   *       IP spoofing이 가능합니다. 신뢰할 수 있는 프록시 뒤에서만 사용하세요.
   */
  trustProxy?: boolean;
  /**
   * 메모리 보호를 위한 최대 key 수
   * - 초과 시 오래된 key부터 제거
   */
  maxKeys?: number;
}

interface NormalizedRateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
  statusCode: number;
  headers: boolean;
  trustProxy: boolean;
  maxKeys: number;
}

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

class MemoryRateLimiter {
  private readonly store = new Map<string, { count: number; resetAt: number }>();
  private lastCleanupAt = 0;

  consume(req: Request, routeId: string, options: NormalizedRateLimitOptions): RateLimitDecision {
    const now = Date.now();
    this.maybeCleanup(now, options);

    const key = `${this.getClientKey(req, options)}:${routeId}`;
    const current = this.store.get(key);

    if (!current || current.resetAt <= now) {
      const resetAt = now + options.windowMs;
      this.store.set(key, { count: 1, resetAt });
      this.enforceMaxKeys(options.maxKeys);
      return { allowed: true, limit: options.max, remaining: Math.max(0, options.max - 1), resetAt };
    }

    current.count += 1;
    this.store.set(key, current);

    return {
      allowed: current.count <= options.max,
      limit: options.max,
      remaining: Math.max(0, options.max - current.count),
      resetAt: current.resetAt,
    };
  }

  private maybeCleanup(now: number, options: NormalizedRateLimitOptions): void {
    if (now - this.lastCleanupAt < Math.max(1_000, options.windowMs)) {
      return;
    }

    this.lastCleanupAt = now;
    for (const [key, entry] of this.store.entries()) {
      if (entry.resetAt <= now) {
        this.store.delete(key);
      }
    }
  }

  private enforceMaxKeys(maxKeys: number): void {
    while (this.store.size > maxKeys) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) break;
      this.store.delete(oldestKey);
    }
  }

  private getClientKey(req: Request, options: NormalizedRateLimitOptions): string {
    const candidates = [
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
      req.headers.get("x-real-ip")?.trim(),
      req.headers.get("cf-connecting-ip")?.trim(),
      req.headers.get("true-client-ip")?.trim(),
      req.headers.get("fly-client-ip")?.trim(),
    ];

    for (const candidate of candidates) {
      if (candidate) {
        const sanitized = candidate.slice(0, 64);
        // trustProxy: false면 경고를 위해 prefix 추가 (spoofing 가능)
        return options.trustProxy ? sanitized : `unverified:${sanitized}`;
      }
    }

    // 헤더가 전혀 없는 경우만 fallback (로컬 개발 환경)
    return "default";
  }
}

function normalizeRateLimitOptions(options: boolean | RateLimitOptions | undefined): NormalizedRateLimitOptions | false {
  if (!options) return false;
  if (options === true) {
    return {
      windowMs: 60_000,
      max: 100,
      message: "Too Many Requests",
      statusCode: 429,
      headers: true,
      trustProxy: false,
      maxKeys: 10_000,
    };
  }

  const windowMs = Number.isFinite(options.windowMs) ? Math.max(1_000, options.windowMs!) : 60_000;
  const max = Number.isFinite(options.max) ? Math.max(1, Math.floor(options.max!)) : 100;
  const statusCode = Number.isFinite(options.statusCode)
    ? Math.min(599, Math.max(400, Math.floor(options.statusCode!)))
    : 429;
  const maxKeys = Number.isFinite(options.maxKeys)
    ? Math.max(100, Math.floor(options.maxKeys!))
    : 10_000;

  return {
    windowMs,
    max,
    message: options.message ?? "Too Many Requests",
    statusCode,
    headers: options.headers ?? true,
    trustProxy: options.trustProxy ?? false,
    maxKeys,
  };
}

function appendRateLimitHeaders(response: Response, decision: RateLimitDecision, options: NormalizedRateLimitOptions): Response {
  if (!options.headers) return response;

  const headers = new Headers(response.headers);
  const retryAfterSec = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));

  headers.set("X-RateLimit-Limit", String(decision.limit));
  headers.set("X-RateLimit-Remaining", String(decision.remaining));
  headers.set("X-RateLimit-Reset", String(Math.floor(decision.resetAt / 1000)));
  headers.set("Retry-After", String(retryAfterSec));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createRateLimitResponse(decision: RateLimitDecision, options: NormalizedRateLimitOptions): Response {
  const response = Response.json(
    {
      error: "rate_limit_exceeded",
      message: options.message,
      limit: decision.limit,
      remaining: decision.remaining,
      retryAfter: Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000)),
    },
    { status: options.statusCode }
  );

  return appendRateLimitHeaders(response, decision, options);
}

// ========== MIME Types ==========
const MIME_TYPES: Record<string, string> = {
  // JavaScript
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/typescript",
  // CSS
  ".css": "text/css",
  // HTML
  ".html": "text/html",
  ".htm": "text/html",
  // JSON
  ".json": "application/json",
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  // Fonts
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  // Documents
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  // Media
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  // Archives
  ".zip": "application/zip",
  ".gz": "application/gzip",
  // WebAssembly
  ".wasm": "application/wasm",
  // Source maps
  ".map": "application/json",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

// ========== Server Options ==========
export interface ServerOptions {
  port?: number;
  hostname?: string;
  /** 프로젝트 루트 디렉토리 */
  rootDir?: string;
  /** 개발 모드 여부 */
  isDev?: boolean;
  /** HMR 포트 (개발 모드에서 사용) */
  hmrPort?: number;
  /** 번들 매니페스트 (Island hydration용) */
  bundleManifest?: BundleManifest;
  /** Public 디렉토리 경로 (기본: 'public') */
  publicDir?: string;
  /**
   * CORS 설정
   * - true: 모든 Origin 허용
   * - false: CORS 비활성화 (기본값)
   * - CorsOptions: 세부 설정
   */
  cors?: boolean | CorsOptions;
  /**
   * Streaming SSR 활성화
   * - true: 모든 페이지에 Streaming SSR 적용
   * - false: 기존 renderToString 사용 (기본값)
   */
  streaming?: boolean;
  /**
   * API 라우트 Rate Limit 설정
   */
  rateLimit?: boolean | RateLimitOptions;
  /**
   * CSS 파일 경로 (SSR 링크 주입용)
   * - string: 해당 경로로 <link> 주입 (예: "/.mandu/client/globals.css")
   * - false: CSS 링크 주입 비활성화 (Tailwind 미사용 시)
   * - undefined: false로 처리 (404 방지, dev/build에서 명시적 전달 필요)
   */
  cssPath?: string | false;
  /**
   * 커스텀 레지스트리 (핸들러/설정 분리)
   * - 제공하지 않으면 기본 전역 레지스트리 사용
   * - 테스트나 멀티앱 시나리오에서 createServerRegistry()로 생성한 인스턴스 전달
   */
  registry?: ServerRegistry;
  /**
   * Guard config for Kitchen dev dashboard (dev mode only)
   */
  guardConfig?: import("../guard/types").GuardConfig | null;
  /**
   * SSR 캐시 설정 (ISR/SWR 용)
   * - true: 기본 메모리 캐시 (LRU 1000 엔트리)
   * - CacheStore: 커스텀 캐시 구현체
   * - false/undefined: 캐시 비활성화
   */
  cache?: boolean | CacheStore;
  /**
   * Internal management token for local CLI/runtime control endpoints.
   * When set, token-protected endpoints such as `/_mandu/cache` become available.
   */
  managementToken?: string;
}

export interface ManduServer {
  server: Server<undefined>;
  router: Router;
  /** 이 서버 인스턴스의 레지스트리 */
  registry: ServerRegistry;
  stop: () => void;
}

export type ApiHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;
export type PageLoader = () => Promise<{ default: React.ComponentType<{ params: Record<string, string> }> }>;

/**
 * Layout 컴포넌트 타입
 * children을 받아서 감싸는 구조
 */
export type LayoutComponent = React.ComponentType<{
  children: React.ReactNode;
  params?: Record<string, string>;
}>;

/**
 * Layout 로더 타입
 */
export type LayoutLoader = () => Promise<{ default: LayoutComponent }>;

/**
 * Loading 컴포넌트 타입
 */
export type LoadingComponent = React.ComponentType<Record<string, never>>;

/**
 * Error 컴포넌트 타입
 */
export type ErrorComponent = React.ComponentType<ErrorFallbackProps>;

/**
 * Loading/Error 로더 타입
 */
export type LoadingLoader = () => Promise<{ default: LoadingComponent }>;
export type ErrorLoader = () => Promise<{ default: ErrorComponent }>;

/**
 * Page 등록 정보
 * - component: React 컴포넌트
 * - filling: Slot의 ManduFilling 인스턴스 (loader 포함)
 */
export interface PageRegistration {
  component: React.ComponentType<{ params: Record<string, string>; loaderData?: unknown }>;
  filling?: ManduFilling<unknown>;
  /** #186: page 모듈의 static `metadata` export (선택) */
  metadata?: Metadata;
  /** #186: page 모듈의 `generateMetadata` 함수 export (선택) */
  generateMetadata?: GenerateMetadata;
}

/**
 * Page Handler - 컴포넌트와 filling을 함께 반환
 */
export type PageHandler = () => Promise<PageRegistration>;

export interface AppContext {
  routeId: string;
  url: string;
  params: Record<string, string>;
  /** SSR loader에서 로드한 데이터 */
  loaderData?: unknown;
}

type RouteComponent = (props: { params: Record<string, string>; loaderData?: unknown }) => React.ReactElement;
type CreateAppFn = (context: AppContext) => React.ReactElement;

// ========== Server Registry (인스턴스별 분리) ==========

/**
 * 서버 인스턴스별 핸들러/설정 레지스트리
 * 같은 프로세스에서 여러 서버를 띄울 때 핸들러가 섞이는 문제 방지
 */
export interface ServerRegistrySettings {
  isDev: boolean;
  hmrPort?: number;
  bundleManifest?: BundleManifest;
  rootDir: string;
  publicDir: string;
  cors?: CorsOptions | false;
  streaming: boolean;
  rateLimit?: NormalizedRateLimitOptions | false;
  /**
   * CSS 파일 경로 (SSR 링크 주입용)
   * - string: 해당 경로로 <link> 주입
   * - false: CSS 링크 주입 비활성화
   * - undefined: false로 처리 (404 방지)
   */
  cssPath?: string | false;
  /** ISR/SWR 캐시 스토어 */
  cacheStore?: CacheStore;
  /** Internal management token for local runtime control */
  managementToken?: string;
}

export class ServerRegistry {
  readonly apiHandlers: Map<string, ApiHandler> = new Map();
  readonly pageLoaders: Map<string, PageLoader> = new Map();
  readonly pageHandlers: Map<string, PageHandler> = new Map();
  readonly pageFillings: Map<string, ManduFilling<unknown>> = new Map();
  readonly routeComponents: Map<string, RouteComponent> = new Map();
  /** Layout 컴포넌트 캐시 (모듈 경로 → 컴포넌트) */
  readonly layoutComponents: Map<string, LayoutComponent> = new Map();
  /** Layout 로더 (모듈 경로 → 로더 함수) */
  readonly layoutLoaders: Map<string, LayoutLoader> = new Map();
  /** Loading 컴포넌트 캐시 (모듈 경로 → 컴포넌트) */
  readonly loadingComponents: Map<string, LoadingComponent> = new Map();
  /** Loading 로더 (모듈 경로 → 로더 함수) */
  readonly loadingLoaders: Map<string, LoadingLoader> = new Map();
  /** Error 컴포넌트 캐시 (모듈 경로 → 컴포넌트) */
  readonly errorComponents: Map<string, ErrorComponent> = new Map();
  /** Error 로더 (모듈 경로 → 로더 함수) */
  readonly errorLoaders: Map<string, ErrorLoader> = new Map();
  createAppFn: CreateAppFn | null = null;
  rateLimiter: MemoryRateLimiter | null = null;
  /** Kitchen dev dashboard handler (dev mode only) */
  kitchen: KitchenHandler | null = null;
  /** 라우트별 캐시 옵션 (filling.loader()의 cacheOptions에서 등록) */
  readonly cacheOptions: Map<string, { revalidate?: number; tags?: string[] }> = new Map();
  /** 라우트별 렌더 모드 */
  readonly renderModes: Map<string, RenderMode> = new Map();
  /** Layout slot 파일 경로 캐시 (모듈 경로 → slot 경로 | null) */
  readonly layoutSlotPaths: Map<string, string | null> = new Map();
  /** WebSocket 핸들러 (라우트 ID → WSHandlers) */
  readonly wsHandlers: Map<string, import("../filling/ws").WSHandlers> = new Map();
  /**
   * Metadata API 캐시 (#186)
   * - pageMetadata: routeId → page 모듈의 static `metadata` export
   * - pageGenerateMetadata: routeId → `generateMetadata` 함수
   * - layoutMetadata: layout 모듈 경로 → static `metadata` export (null = 시도했지만 없음)
   * - layoutGenerateMetadata: layout 모듈 경로 → `generateMetadata` 함수
   */
  readonly pageMetadata: Map<string, import("../seo").Metadata> = new Map();
  readonly pageGenerateMetadata: Map<string, import("../seo").GenerateMetadata> = new Map();
  readonly layoutMetadata: Map<string, import("../seo").Metadata | null> = new Map();
  readonly layoutGenerateMetadata: Map<string, import("../seo").GenerateMetadata> = new Map();
  settings: ServerRegistrySettings = {
    isDev: false,
    rootDir: process.cwd(),
    publicDir: "public",
    cors: false,
    streaming: false,
    rateLimit: false,
  };

  registerApiHandler(routeId: string, handler: ApiHandler): void {
    this.apiHandlers.set(routeId, handler);
  }

  registerPageLoader(routeId: string, loader: PageLoader): void {
    this.pageLoaders.set(routeId, loader);
  }

  registerPageHandler(routeId: string, handler: PageHandler): void {
    this.pageHandlers.set(routeId, handler);
  }

  registerRouteComponent(routeId: string, component: RouteComponent): void {
    this.routeComponents.set(routeId, component);
  }

  /**
   * Layout 로더 등록
   */
  registerLayoutLoader(modulePath: string, loader: LayoutLoader): void {
    this.layoutLoaders.set(modulePath, loader);
  }

  /**
   * Loading 로더 등록
   */
  registerLoadingLoader(modulePath: string, loader: LoadingLoader): void {
    this.loadingLoaders.set(modulePath, loader);
  }

  /**
   * Error 로더 등록
   */
  registerErrorLoader(modulePath: string, loader: ErrorLoader): void {
    this.errorLoaders.set(modulePath, loader);
  }

  /**
   * 제네릭 컴포넌트 로더 (DRY)
   * 캐시 → 로더 → 동적 import 순서로 시도
   */
  private async getComponentByType<T>(
    type: "layout" | "loading" | "error",
    modulePath: string
  ): Promise<T | null> {
    // 타입별 캐시/로더 맵 선택
    const cacheMap = {
      layout: this.layoutComponents,
      loading: this.loadingComponents,
      error: this.errorComponents,
    }[type] as Map<string, T>;

    const loaderMap = {
      layout: this.layoutLoaders,
      loading: this.loadingLoaders,
      error: this.errorLoaders,
    }[type] as Map<string, () => Promise<{ default: T }>>;

    // 1. 캐시 확인
    const cached = cacheMap.get(modulePath);
    if (cached) return cached;

    // #186: layout인 경우 metadata / generateMetadata export를 함께 캐싱
    const cacheLayoutMetadata = (mod: unknown) => {
      if (type !== "layout") return;
      if (this.layoutMetadata.has(modulePath)) return;
      const modObj = (mod && typeof mod === "object" ? (mod as Record<string, unknown>) : null);
      const staticMeta = modObj?.metadata;
      const generateFn = modObj?.generateMetadata;
      this.layoutMetadata.set(
        modulePath,
        staticMeta && typeof staticMeta === "object" ? (staticMeta as Metadata) : null,
      );
      if (typeof generateFn === "function") {
        this.layoutGenerateMetadata.set(modulePath, generateFn as GenerateMetadata);
      }
    };

    // 2. 등록된 로더 시도
    const loader = loaderMap.get(modulePath);
    if (loader) {
      try {
        const module = await loader();
        const component = module.default;
        cacheMap.set(modulePath, component);
        cacheLayoutMetadata(module);
        return component;
      } catch (error) {
        console.error(`[Mandu] Failed to load ${type}: ${modulePath}`, error);
        return null;
      }
    }

    // 3. 동적 import 시도 (보안 검증 포함)
    const validation = validateImportPath(this.settings.rootDir, modulePath);
    if (!validation.ok) {
      console.error(`[Mandu Security] ${validation.error.message}`);
      return null;
    }

    try {
      const module = await import(validation.value);
      const component = module.default;
      cacheMap.set(modulePath, component);
      cacheLayoutMetadata(module);
      return component;
    } catch (error) {
      // layout은 에러 로깅, loading/error는 조용히 실패
      if (type === "layout") {
        console.error(`[Mandu] Failed to load ${type}: ${modulePath}`, error);
      }
      return null;
    }
  }

  /**
   * Layout 컴포넌트 가져오기
   */
  async getLayoutComponent(modulePath: string): Promise<LayoutComponent | null> {
    return this.getComponentByType<LayoutComponent>("layout", modulePath);
  }

  /**
   * Loading 컴포넌트 가져오기
   */
  async getLoadingComponent(modulePath: string): Promise<LoadingComponent | null> {
    return this.getComponentByType<LoadingComponent>("loading", modulePath);
  }

  /**
   * Error 컴포넌트 가져오기
   */
  async getErrorComponent(modulePath: string): Promise<ErrorComponent | null> {
    return this.getComponentByType<ErrorComponent>("error", modulePath);
  }

  setCreateApp(fn: CreateAppFn): void {
    this.createAppFn = fn;
  }

  /**
   * 모든 핸들러/컴포넌트 초기화 (테스트용)
   */
  clear(): void {
    this.apiHandlers.clear();
    this.pageLoaders.clear();
    this.pageHandlers.clear();
    this.routeComponents.clear();
    this.layoutComponents.clear();
    this.layoutLoaders.clear();
    this.loadingComponents.clear();
    this.loadingLoaders.clear();
    this.errorComponents.clear();
    this.errorLoaders.clear();
    this.pageMetadata.clear();
    this.pageGenerateMetadata.clear();
    this.layoutMetadata.clear();
    this.layoutGenerateMetadata.clear();
    this.createAppFn = null;
    this.rateLimiter = null;
  }
}

/**
 * 기본 전역 레지스트리 (하위 호환성)
 */
const defaultRegistry = new ServerRegistry();

/**
 * 새 레지스트리 인스턴스 생성
 * 테스트나 멀티앱 시나리오에서 사용
 */
export function createServerRegistry(): ServerRegistry {
  return new ServerRegistry();
}

/**
 * 기본 레지스트리 초기화 (테스트용)
 */
export function clearDefaultRegistry(): void {
  defaultRegistry.clear();
}

// ========== 하위 호환성을 위한 전역 함수들 (defaultRegistry 사용) ==========

export function registerApiHandler(routeId: string, handler: ApiHandler): void {
  defaultRegistry.registerApiHandler(routeId, handler);
}

export function registerPageLoader(routeId: string, loader: PageLoader): void {
  defaultRegistry.registerPageLoader(routeId, loader);
}

/**
 * Page Handler 등록 (컴포넌트 + filling)
 * filling이 있으면 loader를 실행하여 serverData 전달
 */
export function registerPageHandler(routeId: string, handler: PageHandler): void {
  defaultRegistry.registerPageHandler(routeId, handler);
}

export function registerRouteComponent(routeId: string, component: RouteComponent): void {
  defaultRegistry.registerRouteComponent(routeId, component);
}

export function setCreateApp(fn: CreateAppFn): void {
  defaultRegistry.setCreateApp(fn);
}

/**
 * Layout 로더 등록 (전역)
 */
export function registerLayoutLoader(modulePath: string, loader: LayoutLoader): void {
  defaultRegistry.registerLayoutLoader(modulePath, loader);
}

/**
 * Loading 로더 등록 (전역)
 */
export function registerLoadingLoader(modulePath: string, loader: LoadingLoader): void {
  defaultRegistry.registerLoadingLoader(modulePath, loader);
}

/**
 * Error 로더 등록 (전역)
 */
export function registerErrorLoader(modulePath: string, loader: ErrorLoader): void {
  defaultRegistry.registerErrorLoader(modulePath, loader);
}

export function registerWSHandler(routeId: string, handlers: import("../filling/ws").WSHandlers): void {
  defaultRegistry.wsHandlers.set(routeId, handlers);
}

/**
 * 레이아웃 체인으로 컨텐츠 래핑
 *
 * @param content 페이지 컴포넌트로 렌더된 React Element
 * @param layoutChain 레이아웃 모듈 경로 배열 (외부 → 내부)
 * @param registry ServerRegistry 인스턴스
 * @param params URL 파라미터
 * @returns 래핑된 React Element
 */
async function wrapWithLayouts(
  content: React.ReactElement,
  layoutChain: string[],
  registry: ServerRegistry,
  params: Record<string, string>,
  layoutData?: Map<string, unknown>
): Promise<React.ReactElement> {
  if (!layoutChain || layoutChain.length === 0) {
    return content;
  }

  // 레이아웃 로드 (병렬)
  const layouts = await Promise.all(
    layoutChain.map((modulePath) => registry.getLayoutComponent(modulePath))
  );

  // 내부 → 외부 순서로 래핑 (역순)
  let wrapped = content;
  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = layouts[i];
    if (Layout) {
      // layout별 loader 데이터가 있으면 props로 전달
      const data = layoutData?.get(layoutChain[i]);
      const baseProps = { params, children: wrapped };
      if (data && typeof data === "object") {
        // data에서 children/params 키 제거 → 구조적 props 보호
        const { children: _, params: __, ...safeData } = data as Record<string, unknown>;
        wrapped = React.createElement(Layout as React.ComponentType<Record<string, unknown>>, { ...safeData, ...baseProps });
      } else {
        wrapped = React.createElement(Layout, baseProps);
      }
    }
  }

  return wrapped;
}

// Default createApp implementation (registry 기반)
function createDefaultAppFactory(registry: ServerRegistry) {
  return function defaultCreateApp(context: AppContext): React.ReactElement {
    const Component = registry.routeComponents.get(context.routeId);

    if (!Component) {
      return React.createElement("div", null,
        React.createElement("h1", null, "404 - Route Not Found"),
        React.createElement("p", null, `Route ID: ${context.routeId}`)
      );
    }

    return React.createElement(Component, {
      params: context.params,
      loaderData: context.loaderData,
    });
  };
}

// ========== Static File Serving ==========

interface StaticFileResult {
  handled: boolean;
  response?: Response;
}

const INTERNAL_CACHE_ENDPOINT = "/_mandu/cache";
const INTERNAL_EVENTS_ENDPOINT = "/__mandu/events";

function handleEventsStreamRequest(req: Request): Response {
  const url = new URL(req.url);
  const filterType = url.searchParams.get("type") || undefined;
  const filterSeverity = url.searchParams.get("severity") || undefined;
  const filterSource = url.searchParams.get("source") || undefined;
  const filterTrace = url.searchParams.get("trace") || undefined;

  const matches = (e: import("../observability/event-bus").ObservabilityEvent): boolean => {
    if (filterType && e.type !== filterType) return false;
    if (filterSeverity && e.severity !== filterSeverity) return false;
    if (filterSource && e.source !== filterSource) return false;
    if (filterTrace && e.correlationId !== filterTrace) return false;
    return true;
  };

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string, eventName?: string) => {
        try {
          const prefix = eventName ? `event: ${eventName}\n` : "";
          controller.enqueue(encoder.encode(`${prefix}data: ${data}\n\n`));
        } catch {
          // Stream closed
        }
      };

      // Replay recent events that match filters
      const recent = eventBus.getRecent();
      for (const e of recent) {
        if (matches(e)) send(JSON.stringify(e));
      }

      // Subscribe to live events
      unsubscribe = eventBus.on("*", (event) => {
        if (matches(event)) send(JSON.stringify(event));
      });

      // Heartbeat (comment line) every 15s to keep connection alive
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // ignore
        }
      }, 15000);

      // Tear down when client disconnects
      const signal = req.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
          try { controller.close(); } catch { /* noop */ }
        });
      }
    },
    cancel() {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function handleEventsRecentRequest(req: Request): Response {
  const url = new URL(req.url);
  const count = url.searchParams.get("count");
  const type = url.searchParams.get("type") || undefined;
  const severity = url.searchParams.get("severity") || undefined;
  const windowParam = url.searchParams.get("windowMs");
  const windowMs = windowParam ? Number(windowParam) : undefined;

  const events = eventBus.getRecent(
    count ? Number(count) : undefined,
    {
      type: type as import("../observability/event-bus").EventType | undefined,
      severity: severity as import("../observability/event-bus").ObservabilitySeverity | undefined,
    },
  );
  const stats = eventBus.getStats(windowMs);
  return Response.json({ events, stats });
}

function createStaticErrorResponse(status: 400 | 403 | 404 | 500): Response {
  const body = {
    400: "Bad Request",
    403: "Forbidden",
    404: "Not Found",
    500: "Internal Server Error",
  }[status];

  return new Response(body, { status });
}

/**
 * 경로가 허용된 디렉토리 내에 있는지 검증
 * Path traversal 공격 방지
 */
async function isPathSafe(filePath: string, allowedDir: string): Promise<boolean> {
  try {
    const resolvedPath = path.resolve(filePath);
    const resolvedAllowedDir = path.resolve(allowedDir);

    if (!resolvedPath.startsWith(resolvedAllowedDir + path.sep) &&
        resolvedPath !== resolvedAllowedDir) {
      return false;
    }

    // 파일이 없으면 안전 (존재하지 않는 경로)
    try {
      await fs.access(resolvedPath);
    } catch {
      return true;
    }

    // Symlink 해결 후 재검증
    const realPath = await fs.realpath(resolvedPath);
    const realAllowedDir = await fs.realpath(resolvedAllowedDir);

    return realPath.startsWith(realAllowedDir + path.sep) ||
           realPath === realAllowedDir;
  } catch (error) {
    console.warn(`[Mandu Security] Path validation failed: ${filePath}`, error);
    return false;
  }
}

/**
 * 정적 파일 서빙
 * - /.mandu/client/* : 클라이언트 번들 (Island hydration)
 * - /public/* : 정적 에셋 (이미지, CSS 등)
 * - /favicon.ico : 파비콘
 *
 * 보안: Path traversal 공격 방지를 위해 모든 경로를 검증합니다.
 */
async function serveStaticFile(pathname: string, settings: ServerRegistrySettings, request?: Request): Promise<StaticFileResult> {
  let filePath: string | null = null;
  let isBundleFile = false;
  let allowedBaseDir: string;
  let relativePath: string;

  // 1. 클라이언트 번들 파일 (/.mandu/client/*)
  if (pathname.startsWith("/.mandu/client/")) {
    // pathname에서 prefix 제거 후 안전하게 조합
    relativePath = pathname.slice("/.mandu/client/".length);
    allowedBaseDir = path.join(settings.rootDir, ".mandu", "client");
    isBundleFile = true;
  }
  // 2. Public 폴더 파일 (/public/*)
  else if (pathname.startsWith("/public/")) {
    relativePath = pathname.slice("/public/".length);
    allowedBaseDir = path.join(settings.rootDir, settings.publicDir);
  }
  // 3. .well-known/ 디렉토리 (#178: RFC 8615 표준 — Chrome DevTools, ACME, etc.)
  else if (pathname.startsWith("/.well-known/")) {
    relativePath = pathname.slice(1); // ".well-known/..."
    allowedBaseDir = path.join(settings.rootDir, settings.publicDir);
  }
  // 4. Public 폴더의 루트 파일 (favicon.ico, robots.txt 등)
  else if (
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/manifest.json"
  ) {
    relativePath = path.basename(pathname);
    allowedBaseDir = path.join(settings.rootDir, settings.publicDir);
  } else {
    return { handled: false }; // 정적 파일이 아님
  }

  // URL 디코딩 (실패 시 차단)
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    return { handled: true, response: createStaticErrorResponse(400) };
  }

  // 정규화 + Null byte 방지
  const normalizedPath = path.posix.normalize(decodedPath);
  if (normalizedPath.includes("\0")) {
    console.warn(`[Mandu Security] Null byte attack detected: ${pathname}`);
    return { handled: true, response: createStaticErrorResponse(400) };
  }

  const normalizedSegments = normalizedPath.split("/");
  if (normalizedSegments.some((segment) => segment === "..")) {
    return { handled: true, response: createStaticErrorResponse(403) };
  }

  // 선행 슬래시 제거 → path.join이 base를 무시하지 않도록 보장
  const safeRelativePath = normalizedPath.replace(/^\/+/, "");
  filePath = path.join(allowedBaseDir, safeRelativePath);

  // 최종 경로 검증: 허용된 디렉토리 내에 있는지 확인
  if (!(await isPathSafe(filePath, allowedBaseDir!))) {
    console.warn(`[Mandu Security] Path traversal attempt blocked: ${pathname}`);
    return { handled: true, response: createStaticErrorResponse(403) };
  }

  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return { handled: true, response: createStaticErrorResponse(404) };
    }

    const mimeType = getMimeType(filePath);

    // Cache-Control 헤더 설정
    let cacheControl: string;
    if (settings.isDev) {
      // 개발 모드: 캐시 없음
      cacheControl = "no-cache, no-store, must-revalidate";
    } else if (isBundleFile) {
      // 프로덕션 번들: 1년 캐시 (파일명에 해시 포함 가정)
      cacheControl = "public, max-age=31536000, immutable";
    } else {
      // 프로덕션 일반 정적 파일: 1일 캐시
      cacheControl = "public, max-age=86400";
    }

    // ETag: weak validator (파일 크기 + 최종 수정 시간)
    const etag = `W/"${file.size.toString(36)}-${file.lastModified.toString(36)}"`;

    // 304 Not Modified — 불필요한 전송 방지
    const ifNoneMatch = request?.headers.get("If-None-Match");
    if (ifNoneMatch === etag) {
      return {
        handled: true,
        response: new Response(null, {
          status: 304,
          headers: { "ETag": etag, "Cache-Control": cacheControl },
        }),
      };
    }

    return {
      handled: true,
      response: new Response(file, {
        headers: {
          "Content-Type": mimeType,
          "Cache-Control": cacheControl,
          "ETag": etag,
        },
      }),
    };
  } catch {
    return { handled: true, response: createStaticErrorResponse(500) };
  }
}

// ========== Request Handler ==========

function unauthorizedControlResponse(): Response {
  return Response.json({ error: "Unauthorized runtime control request" }, { status: 401 });
}

function resolveInternalCacheTarget(payload: Record<string, unknown>): string {
  if (typeof payload.path === "string" && payload.path.length > 0) {
    return `path=${payload.path}`;
  }
  if (typeof payload.tag === "string" && payload.tag.length > 0) {
    return `tag=${payload.tag}`;
  }
  if (payload.all === true) {
    return "all";
  }
  return "unknown";
}

async function handleInternalCacheControlRequest(
  req: Request,
  settings: ServerRegistrySettings
): Promise<Response> {
  const expectedToken = settings.managementToken;
  const providedToken = req.headers.get("x-mandu-control-token");

  if (!expectedToken || providedToken !== expectedToken) {
    return unauthorizedControlResponse();
  }

  const store = settings.cacheStore ?? null;
  if (!store) {
    return Response.json({
      enabled: false,
      message: "Runtime cache is disabled for this server instance.",
      stats: null,
    });
  }

  if (req.method === "GET") {
    const stats = getCacheStoreStats(store);
    return Response.json({
      enabled: true,
      message: "Runtime cache is available.",
      stats,
    });
  }

  if (req.method === "POST" || req.method === "DELETE") {
    let payload: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        payload = await req.json() as Record<string, unknown>;
      } catch (parseErr) {
        const detail = parseErr instanceof Error ? parseErr.message : "Invalid JSON";
        return Response.json({ error: "Invalid JSON body", detail, hint: "Ensure the request body is valid JSON (e.g., no trailing commas, unquoted keys, or truncated input)." }, { status: 400 });
      }
    } else {
      payload = { all: true };
    }

    const before = store.size;
    if (typeof payload.path === "string" && payload.path.length > 0) {
      store.deleteByPath(payload.path);
    } else if (typeof payload.tag === "string" && payload.tag.length > 0) {
      store.deleteByTag(payload.tag);
    } else if (payload.all === true) {
      store.clear();
    } else {
      return Response.json({
        error: "Provide one of: { path }, { tag }, or { all: true }",
      }, { status: 400 });
    }

    const after = store.size;
    const stats: CacheStoreStats | null = getCacheStoreStats(store);

    return Response.json({
      enabled: true,
      cleared: Math.max(0, before - after),
      target: resolveInternalCacheTarget(payload),
      stats,
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed", allowed: ["GET", "POST", "DELETE"], hint: `Received '${req.method}'. This endpoint accepts GET (read stats), POST (clear by path/tag), and DELETE (clear all).` }), { status: 405, headers: { "Content-Type": "application/json", "Allow": "GET, POST, DELETE" } });
}

async function handleRequest(req: Request, router: Router, registry: ServerRegistry): Promise<Response> {
  const requestStart = Date.now();
  // Phase 1-4: Correlation ID — 한 요청에서 발생하는 모든 이벤트를 추적
  const correlationId = req.headers.get("x-mandu-request-id") ?? crypto.randomUUID();
  const result = await handleRequestInternal(req, router, registry);

  if (!result.ok) {
    const errorResponse = errorToResponse(result.error, registry.settings.isDev);
    if (registry.settings.isDev) {
      // #177: dev 모드 에러 응답도 캐시 방지
      if (!errorResponse.headers.has("Cache-Control")) {
        errorResponse.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      }
      const url = new URL(req.url);
      const p = url.pathname;
      if (!p.startsWith("/.mandu/") && !p.startsWith("/__kitchen") && !p.startsWith("/__mandu/")) {
        const elapsed = Date.now() - requestStart;
        console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${p} ${errorResponse.status} ${elapsed}ms`);
        recordRequest({ id: correlationId, method: req.method, path: p, status: errorResponse.status, duration: elapsed, timestamp: Date.now() });
        // Phase 1-2: HTTP 요청 → EventBus
        eventBus.emit({
          type: "http",
          severity: errorResponse.status >= 500 ? "error" : errorResponse.status >= 400 ? "warn" : "info",
          source: "server",
          correlationId,
          message: `${req.method} ${p} ${errorResponse.status}`,
          duration: elapsed,
          data: { method: req.method, path: p, status: errorResponse.status, error: true },
        });
      }
    }
    return errorResponse;
  }

  if (registry.settings.isDev) {
    const url = new URL(req.url);
    const p = url.pathname;

    // #177: dev 모드에서 SSR HTML 응답에 Cache-Control 헤더 추가
    // 브라우저가 오래된 HTML을 캐시하여 변경사항이 반영 안 되는 문제 방지
    if (!result.value.headers.has("Cache-Control")) {
      result.value.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    }

    if (!p.startsWith("/.mandu/") && !p.startsWith("/__kitchen") && !p.startsWith("/__mandu/")) {
      const elapsed = Date.now() - requestStart;
      const status = result.value.status;
      const cacheHdr = result.value.headers.get("X-Mandu-Cache") ?? "";
      const cacheTag = cacheHdr ? ` ${cacheHdr}` : "";
      console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${p} ${status} ${elapsed}ms${cacheTag}`);
      recordRequest({ id: correlationId, method: req.method, path: p, status, duration: elapsed, timestamp: Date.now(), cacheStatus: cacheHdr || undefined });
      // Phase 1-2: HTTP 요청 → EventBus
      eventBus.emit({
        type: "http",
        severity: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        source: "server",
        correlationId,
        message: `${req.method} ${p} ${status}${cacheTag}`,
        duration: elapsed,
        data: { method: req.method, path: p, status, cache: cacheHdr || undefined },
      });
    }
  }

  return result.value;
}

// ---------- API Route Handler ----------

/**
 * API 라우트 처리
 */
async function handleApiRoute(
  req: Request,
  route: { id: string; pattern: string },
  params: Record<string, string>,
  registry: ServerRegistry
): Promise<Result<Response>> {
  const handler = registry.apiHandlers.get(route.id);

  if (!handler) {
    return err(createHandlerNotFoundResponse(route.id, route.pattern));
  }

  try {
    const response = await handler(req, params);
    return ok(response);
  } catch (errValue) {
    const error = errValue instanceof Error ? errValue : new Error(String(errValue));
    return err(createSSRErrorResponse(route.id, route.pattern, error));
  }
}

// ---------- Page Data Loader ----------

interface PageLoadResult {
  loaderData: unknown;
  cookies?: CookieManager;
  /** Layout별 loader 데이터 (모듈 경로 → 데이터) */
  layoutData?: Map<string, unknown>;
}

/**
 * 페이지 컴포넌트 및 loader 데이터 로딩
 */
async function loadPageData(
  req: Request,
  route: { id: string; pattern: string; layoutChain?: string[] },
  params: Record<string, string>,
  registry: ServerRegistry
): Promise<Result<PageLoadResult>> {
  let loaderData: unknown;

  // 1. PageHandler 방식 (신규 - filling 포함)
  const pageHandler = registry.pageHandlers.get(route.id);
  if (pageHandler) {
    let cookies: CookieManager | undefined;
    try {
      const registration = await ensurePageRouteMetadata(route.id, registry, pageHandler);

      // Filling의 loader 실행
      if (registration.filling?.hasLoader()) {
        const ctx = new ManduContext(req, params);
        loaderData = await registration.filling.executeLoader(ctx);
        if (ctx.cookies.hasPendingCookies()) {
          cookies = ctx.cookies;
        }
      }
    } catch (error) {
      const pageError = createPageLoadErrorResponse(
        route.id,
        route.pattern,
        error instanceof Error ? error : new Error(String(error))
      );
      console.error(`[Mandu] ${pageError.errorType}:`, pageError.message);
      return err(pageError);
    }

    return ok({ loaderData, cookies });
  }

  // 2. PageLoader 방식 (레거시 호환)
  const loader = registry.pageLoaders.get(route.id);
  if (loader) {
    try {
      const module = await loader();
      const exported: unknown = module.default;
      const exportedObj = exported as Record<string, unknown> | null;
      const component = typeof exported === "function"
        ? (exported as RouteComponent)
        : (exportedObj?.component ?? exported);
      registry.registerRouteComponent(route.id, component as RouteComponent);

      // #186: page 모듈에서 metadata / generateMetadata export 캐싱
      const modObj = module as Record<string, unknown>;
      if (modObj.metadata && typeof modObj.metadata === "object") {
        registry.pageMetadata.set(route.id, modObj.metadata as Metadata);
      }
      if (typeof modObj.generateMetadata === "function") {
        registry.pageGenerateMetadata.set(
          route.id,
          modObj.generateMetadata as GenerateMetadata,
        );
      }

      // filling이 있으면 캐시 옵션 등록 + loader 실행
      let cookies: CookieManager | undefined;
      const filling = typeof exported === "object" && exported !== null ? (exportedObj as Record<string, unknown>)?.filling as ManduFilling | null : null;
      if (filling?.getCacheOptions?.()) {
        registry.cacheOptions.set(route.id, filling.getCacheOptions()!);
      }
      if (filling?.hasLoader?.()) {
        const ctx = new ManduContext(req, params);
        loaderData = await filling.executeLoader(ctx);
        if (ctx.cookies.hasPendingCookies()) {
          cookies = ctx.cookies;
        }
      }

      return ok({ loaderData, cookies });
    } catch (error) {
      const pageError = createPageLoadErrorResponse(
        route.id,
        route.pattern,
        error instanceof Error ? error : new Error(String(error))
      );
      console.error(`[Mandu] ${pageError.errorType}:`, pageError.message);
      return err(pageError);
    }
  }

  return ok({ loaderData });
}

/**
 * Layout chain의 모든 loader를 병렬 실행
 * 각 layout.slot.ts가 있으면 해당 데이터를 layout props로 전달
 */
async function loadLayoutData(
  req: Request,
  layoutChain: string[] | undefined,
  params: Record<string, string>,
  registry: ServerRegistry
): Promise<Map<string, unknown>> {
  const layoutData = new Map<string, unknown>();
  if (!layoutChain || layoutChain.length === 0) return layoutData;

  // layout.slot.ts 파일 검색: layout 모듈 경로에서 .slot.ts 파일 경로 유도
  // 예: app/layout.tsx → spec/slots/layout.slot.ts (auto-link 규칙)
  // 또는 직접 등록된 layout loader에서 filling 추출

  const loaderEntries: { modulePath: string; slotPath: string }[] = [];
  for (const modulePath of layoutChain) {
    // 캐시된 결과 확인
    if (registry.layoutSlotPaths.has(modulePath)) {
      const cached = registry.layoutSlotPaths.get(modulePath);
      if (cached) loaderEntries.push({ modulePath, slotPath: cached });
      continue;
    }

    // layout.tsx → layout 이름 추출 → 같은 디렉토리에서 .slot.ts 검색
    const layoutName = path.basename(modulePath, path.extname(modulePath));
    const slotCandidates = [
      path.join(path.dirname(modulePath), `${layoutName}.slot.ts`),
      path.join(path.dirname(modulePath), `${layoutName}.slot.tsx`),
    ];
    let found = false;
    for (const slotPath of slotCandidates) {
      try {
        const fullPath = path.join(registry.settings.rootDir, slotPath);
        const file = Bun.file(fullPath);
        if (await file.exists()) {
          registry.layoutSlotPaths.set(modulePath, fullPath);
          loaderEntries.push({ modulePath, slotPath: fullPath });
          found = true;
          break;
        }
      } catch {
        // 파일 없으면 스킵
      }
    }
    if (!found) {
      registry.layoutSlotPaths.set(modulePath, null); // 없음 캐시
    }
  }

  if (loaderEntries.length === 0) return layoutData;

  const results = await Promise.all(
    loaderEntries.map(async ({ modulePath, slotPath }) => {
      try {
        const module = await import(slotPath);
        const exported = module.default;
        // layout.slot.ts가 ManduFilling이면 loader 실행
        if (exported && typeof exported === "object" && "executeLoader" in exported) {
          const filling = exported as ManduFilling;
          if (filling.hasLoader()) {
            const ctx = new ManduContext(req, params);
            const data = await filling.executeLoader(ctx);
            return { modulePath, data };
          }
        }
      } catch (error) {
        console.warn(`[Mandu] Layout loader failed for ${modulePath}:`, error);
      }
      return { modulePath, data: undefined };
    })
  );

  for (const { modulePath, data } of results) {
    if (data !== undefined) {
      layoutData.set(modulePath, data);
    }
  }

  return layoutData;
}

// ---------- SSR Renderer ----------

/**
 * #186: URL에서 searchParams를 Record<string, string>로 추출 (SEO 모듈 시그니처)
 */
function extractSearchParams(url: string): Record<string, string> {
  try {
    const u = new URL(url);
    const result: Record<string, string> = {};
    for (const [key, value] of u.searchParams.entries()) {
      if (!(key in result)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * #186: layout chain + page metadata를 순서대로 수집해 MetadataItem[] 구성
 * - 각 layout의 generateMetadata 우선, 없으면 static metadata
 * - page 모듈의 generateMetadata 우선, 없으면 static metadata
 * - 결과 배열을 SEO 모듈의 resolveMetadata에 전달
 */
async function collectMetadataItems(
  route: { id: string; layoutChain?: string[] },
  registry: ServerRegistry,
): Promise<MetadataItem[]> {
  const items: MetadataItem[] = [];

  if (route.layoutChain) {
    for (const layoutPath of route.layoutChain) {
      // Layout 모듈 로드 → metadata / generateMetadata 캐시 채움
      await registry.getLayoutComponent(layoutPath);
      const dyn = registry.layoutGenerateMetadata.get(layoutPath);
      if (dyn) {
        items.push(dyn);
        continue;
      }
      const staticMeta = registry.layoutMetadata.get(layoutPath);
      if (staticMeta) items.push(staticMeta);
    }
  }

  const pageDyn = registry.pageGenerateMetadata.get(route.id);
  if (pageDyn) {
    items.push(pageDyn);
  } else {
    const pageStatic = registry.pageMetadata.get(route.id);
    if (pageStatic) items.push(pageStatic);
  }

  return items;
}

/**
 * #186: 해석된 Metadata를 SSR 옵션(title + headTags)으로 변환
 */
async function buildSSRMetadata(
  route: { id: string; layoutChain?: string[] },
  params: Record<string, string>,
  url: string,
  registry: ServerRegistry,
): Promise<{ title: string; headTags: string }> {
  try {
    const items = await collectMetadataItems(route, registry);
    if (items.length === 0) {
      return { title: "Mandu App", headTags: "" };
    }
    const resolved = await resolveMetadata(items, params, extractSearchParams(url));
    const titleHtml = renderTitle(resolved);
    const headTags = renderMetadata(resolved);
    // resolveMetadata는 <title>을 headTags 안에 이미 포함시키므로,
    // 중복 방지를 위해 title은 문자열만 뽑고 headTags에서 <title>을 제거
    const title = extractTitleText(titleHtml) ?? "Mandu App";
    const headWithoutTitle = headTags.replace(/<title>[^<]*<\/title>\n?/i, "");
    return { title, headTags: headWithoutTitle };
  } catch (error) {
    console.warn("[Mandu] metadata resolution failed:", error);
    return { title: "Mandu App", headTags: "" };
  }
}

function extractTitleText(titleHtml: string): string | null {
  const match = /<title>([^<]*)<\/title>/i.exec(titleHtml);
  return match ? match[1] : null;
}

/**
 * SSR 렌더링 (Streaming/Non-streaming)
 */
async function renderPageSSR(
  route: { id: string; pattern: string; layoutChain?: string[]; streaming?: boolean; hydration?: HydrationConfig; errorModule?: string },
  params: Record<string, string>,
  loaderData: unknown,
  url: string,
  registry: ServerRegistry,
  cookies?: CookieManager,
  layoutData?: Map<string, unknown>
): Promise<Result<Response>> {
  const settings = registry.settings;
  const defaultAppCreator = createDefaultAppFactory(registry);
  const appCreator = registry.createAppFn || defaultAppCreator;

  try {
    let app = appCreator({
      routeId: route.id,
      url,
      params,
      loaderData,
    });

    // Island 래핑: 레이아웃 적용 전에 페이지 콘텐츠만 island div로 감쌈
    // 이렇게 하면 레이아웃은 island 바깥에 위치하여 하이드레이션 시 레이아웃이 유지됨
    const needsIslandWrap =
      route.hydration &&
      route.hydration.strategy !== "none" &&
      settings.bundleManifest;

    if (needsIslandWrap) {
      const bundle = settings.bundleManifest?.bundles[route.id];
      const bundleSrc = bundle?.js ? `${bundle.js}?t=${Date.now()}` : "";
      const priority = route.hydration!.priority || "visible";
      app = React.createElement("div", {
        "data-mandu-island": route.id,
        "data-mandu-src": bundleSrc,
        "data-mandu-priority": priority,
        style: { display: "contents" },
      }, app);
    }

    // 레이아웃 체인 적용 (island 래핑 후 → 레이아웃은 island 바깥)
    if (route.layoutChain && route.layoutChain.length > 0) {
      app = await wrapWithLayouts(app, route.layoutChain, registry, params, layoutData);
    }

    const serverData = loaderData
      ? { [route.id]: { serverData: loaderData } }
      : undefined;

    // #186: layout chain + page metadata 병합
    const builtMeta = await buildSSRMetadata(route, params, url, registry);

    // Streaming SSR 모드 결정
    const useStreaming = route.streaming !== undefined
      ? route.streaming
      : settings.streaming;

    if (useStreaming) {
      const streamingResponse = await renderStreamingResponse(app, {
        title: builtMeta.title,
        headTags: builtMeta.headTags,
        isDev: settings.isDev,
        hmrPort: settings.hmrPort,
        routeId: route.id,
        routePattern: route.pattern,
        hydration: route.hydration,
        bundleManifest: settings.bundleManifest,
        criticalData: loaderData as Record<string, unknown> | undefined,
        enableClientRouter: true,
        cssPath: settings.cssPath,
        onShellReady: () => {
          if (settings.isDev) {
            console.log(`[Mandu Streaming] Shell ready: ${route.id}`);
          }
        },
        onMetrics: (metrics) => {
          if (settings.isDev) {
            console.log(`[Mandu Streaming] Metrics for ${route.id}:`, {
              shellReadyTime: `${metrics.shellReadyTime}ms`,
              allReadyTime: `${metrics.allReadyTime}ms`,
              hasError: metrics.hasError,
            });
          }
        },
      });
      return ok(cookies ? cookies.applyToResponse(streamingResponse) : streamingResponse);
    }

    // 기존 renderToString 방식
    // Note: hydration 래핑은 위에서 React 엘리먼트 레벨로 이미 처리됨
    // renderToHTML에서 중복 래핑하지 않도록 hydration을 전달하되 strategy를 "none"으로 설정
    // 단, hydration 스크립트(importmap, runtime 등)는 여전히 필요하므로 bundleManifest는 유지
    const ssrResponse = renderSSR(app, {
      title: builtMeta.title,
      headTags: builtMeta.headTags,
      isDev: settings.isDev,
      hmrPort: settings.hmrPort,
      routeId: route.id,
      hydration: route.hydration,
      bundleManifest: settings.bundleManifest,
      serverData,
      enableClientRouter: true,
      routePattern: route.pattern,
      cssPath: settings.cssPath,
      islandPreWrapped: !!needsIslandWrap,
    });
    return ok(cookies ? cookies.applyToResponse(ssrResponse) : ssrResponse);
  } catch (error) {
    const renderError = error instanceof Error ? error : new Error(String(error));

    // Route-level ErrorBoundary: errorModule이 있으면 해당 컴포넌트로 에러 렌더링
    if (route.errorModule) {
      try {
        const errorMod = await import(path.join(settings.rootDir, route.errorModule));
        const ErrorComponent = errorMod.default as React.ComponentType<ErrorFallbackProps>;
        if (ErrorComponent) {
          const errorElement = React.createElement(ErrorComponent, {
            error: renderError,
            errorInfo: undefined,
            resetError: () => {}, // SSR에서는 noop — 클라이언트 hydration 시 실제 동작
          });

          // 레이아웃은 유지하면서 에러 컴포넌트만 교체
          let errorApp: React.ReactElement = errorElement;
          if (route.layoutChain && route.layoutChain.length > 0) {
            errorApp = await wrapWithLayouts(errorApp, route.layoutChain, registry, params, layoutData);
          }

          const errorHtml = renderSSR(errorApp, {
            // 에러 상태에서는 resolveMetadata 결과를 신뢰할 수 없을 수 있으므로 리터럴 사용
            title: "Mandu App — Error",
            isDev: settings.isDev,
            cssPath: settings.cssPath,
          });
          return ok(cookies ? cookies.applyToResponse(errorHtml) : errorHtml);
        }
      } catch (errorBoundaryError) {
        console.error(`[Mandu] Error boundary failed for ${route.id}:`, errorBoundaryError);
      }
    }

    const ssrError = createSSRErrorResponse(
      route.id,
      route.pattern,
      renderError
    );
    console.error(`[Mandu] ${ssrError.errorType}:`, ssrError.message);
    return err(ssrError);
  }
}

// ---------- Page Route Handler ----------

/** SWR 백그라운드 재생성 중복 방지 */
const pendingRevalidations = new Set<string>();

/**
 * 페이지 라우트 처리
 */
async function handlePageRoute(
  req: Request,
  url: URL,
  route: { id: string; pattern: string; layoutChain?: string[]; streaming?: boolean; hydration?: HydrationConfig },
  params: Record<string, string>,
  registry: ServerRegistry
): Promise<Result<Response>> {
  const settings = registry.settings;
  const cache = settings.cacheStore;
  // Only call ensurePageRouteMetadata when a pageHandler exists;
  // routes registered via registerPageLoader are handled by loadPageData instead.
  if (registry.pageHandlers.has(route.id)) {
    await ensurePageRouteMetadata(route.id, registry);
  }
  const renderMode = getRenderModeForRoute(route.id, registry);

  // _data 요청 (SPA 네비게이션)은 캐시하지 않음
  const isDataRequest = url.searchParams.has("_data");

  // PPR: cached shell + fresh dynamic data per request
  if (renderMode === "ppr" && cache && !isDataRequest) {
    const shellCacheKey = `ppr-shell:${route.id}`;
    const cachedShell = cache.get(shellCacheKey);

    if (cachedShell) {
      // Shell HIT: load only the dynamic data (cheap), skip full SSR render
      const loadResult = await loadPageData(req, route, params, registry);
      if (!loadResult.ok) return loadResult;
      const { loaderData, cookies } = loadResult.value;
      const pprResponse = createPPRResponse(cachedShell.html, route.id, loaderData);
      return ok(cookies ? cookies.applyToResponse(pprResponse) : pprResponse);
    }

    // Shell MISS: fall through to full render, then cache the shell below
  }

  // ISR/SWR 캐시 확인 (SSR 렌더링 요청에만 적용)
  if (cache && !isDataRequest && renderMode !== "dynamic" && renderMode !== "ppr") {
    const cacheKey = buildRouteCacheKey(route.id, url);
    const lookup = lookupCache(cache, cacheKey);

    if (lookup.status === "HIT" && lookup.entry) {
      return ok(createCachedResponse(lookup.entry, "HIT"));
    }

    if (lookup.status === "STALE" && lookup.entry) {
      // Stale-While-Revalidate: 이전 캐시 즉시 반환 + 백그라운드 재생성
      // 중복 재생성 방지: 이미 진행 중이면 스킵
      if (!pendingRevalidations.has(cacheKey)) {
        pendingRevalidations.add(cacheKey);
        queueMicrotask(async () => {
          try {
            await regenerateCache(req, url, route, params, registry, cache, cacheKey);
          } catch (error) {
            console.warn(`[Mandu Cache] Background revalidation failed for ${cacheKey}:`, error);
          } finally {
            pendingRevalidations.delete(cacheKey);
          }
        });
      }
      return ok(createCachedResponse(lookup.entry, "STALE"));
    }
  }

  // 1. 페이지 + 레이아웃 데이터 병렬 로딩
  const [loadResult, layoutData] = await Promise.all([
    loadPageData(req, route, params, registry),
    loadLayoutData(req, route.layoutChain, params, registry),
  ]);
  if (!loadResult.ok) {
    return loadResult;
  }

  const { loaderData, cookies } = loadResult.value;

  // 2. Client-side Routing: 데이터만 반환 (JSON)
  // 참고: layoutData는 SSR 시에만 사용 — SPA 네비게이션은 전체 페이지 SSR을 받지 않으므로 제외
  if (isDataRequest) {
    const jsonResponse = Response.json({
      routeId: route.id,
      pattern: route.pattern,
      params,
      loaderData: loaderData ?? null,
      timestamp: Date.now(),
    });
    return ok(cookies ? cookies.applyToResponse(jsonResponse) : jsonResponse);
  }

  // 3. SSR 렌더링 (layoutData 전달)
  const ssrResult = await renderPageSSR(route, params, loaderData, req.url, registry, cookies, layoutData);

  // 4a. PPR: cache only the shell (HTML structure minus loader data), not the full page
  if (cache && ssrResult.ok && renderMode === "ppr") {
    const cacheOptions = getCacheOptionsForRoute(route.id, registry);
    const revalidate = cacheOptions?.revalidate ?? 3600; // default 1 hour for PPR shells
    const shellCacheKey = `ppr-shell:${route.id}`;
    const cloned = ssrResult.value.clone();
    cloned.text().then((html) => {
      const shellHtml = extractShellHtml(html);
      cache.set(shellCacheKey, createCacheEntry(
        shellHtml, null, revalidate, cacheOptions?.tags ?? []
      ));
    }).catch(() => {});
  }

  // 4b. ISR/SWR 캐시 저장 (revalidate 설정이 있는 경우 — non-blocking)
  if (cache && ssrResult.ok && renderMode !== "dynamic" && renderMode !== "ppr") {
    const cacheOptions = getCacheOptionsForRoute(route.id, registry);
    if (cacheOptions?.revalidate && cacheOptions.revalidate > 0) {
      const cloned = ssrResult.value.clone();
      const status = ssrResult.value.status;
      const headers = Object.fromEntries(ssrResult.value.headers.entries());
      const cacheKey = buildRouteCacheKey(route.id, url);
      // streaming 응답도 블로킹하지 않도록 백그라운드에서 캐시 저장
      cloned.text().then((html) => {
        cache.set(cacheKey, createCacheEntry(
          html, loaderData, cacheOptions.revalidate!, cacheOptions.tags ?? [], status, headers
        ));
      }).catch(() => {});
    }
  }

  return ssrResult;
}

/**
 * 백그라운드 캐시 재생성 (SWR 패턴)
 */
async function regenerateCache(
  req: Request,
  url: URL,
  route: { id: string; pattern: string; layoutChain?: string[]; streaming?: boolean; hydration?: HydrationConfig },
  params: Record<string, string>,
  registry: ServerRegistry,
  cache: CacheStore,
  cacheKey: string
): Promise<void> {
  const [loadResult, layoutData] = await Promise.all([
    loadPageData(req, route, params, registry),
    loadLayoutData(req, route.layoutChain, params, registry),
  ]);
  if (!loadResult.ok) return;

  const { loaderData } = loadResult.value;
  const ssrResult = await renderPageSSR(route, params, loaderData, req.url, registry, undefined, layoutData);
  if (!ssrResult.ok) return;

  const cacheOptions = getCacheOptionsForRoute(route.id, registry);
  if (!cacheOptions?.revalidate) return;

  const html = await ssrResult.value.text();
  const entry = createCacheEntry(
    html,
    loaderData,
    cacheOptions.revalidate,
    cacheOptions.tags ?? [],
    ssrResult.value.status,
    Object.fromEntries(ssrResult.value.headers.entries())
  );
  cache.set(cacheKey, entry);
}

/**
 * 라우트의 캐시 옵션 가져오기 (pageHandler의 filling에서 추출)
 */
function getCacheOptionsForRoute(
  routeId: string,
  registry: ServerRegistry
): { revalidate?: number; tags?: string[] } | null {
  const pageHandler = registry.pageHandlers.get(routeId);
  if (!pageHandler) return null;

  // pageHandler는 async () => { component, filling } 형태
  // filling의 getCacheOptions()를 호출하려면 filling 인스턴스에 접근해야 하지만
  // pageHandler 실행 없이는 접근 불가 → 등록 시점에 캐시 옵션을 별도 저장
  return registry.cacheOptions?.get(routeId) ?? null;
}

function getRenderModeForRoute(routeId: string, registry: ServerRegistry): RenderMode {
  return registry.renderModes.get(routeId) ?? "dynamic";
}

async function ensurePageRouteMetadata(
  routeId: string,
  registry: ServerRegistry,
  pageHandler?: PageHandler
): Promise<PageRegistration> {
  const handler = pageHandler ?? registry.pageHandlers.get(routeId);
  if (!handler) {
    throw new Error(`Page handler not found for route: '${routeId}'. Ensure this route is registered in the manifest. If you are running in development, restart 'mandu dev' to pick up new routes. In production, verify that the route module exists and was included in the build.`);
  }

  const existingComponent = registry.routeComponents.get(routeId);
  const existingFilling = registry.pageFillings.get(routeId);
  if (existingComponent && existingFilling) {
    return { component: existingComponent, filling: existingFilling };
  }

  const registration = await handler();
  const component = registration.component as RouteComponent;
  registry.registerRouteComponent(routeId, component);

  if (registration.filling) {
    registry.pageFillings.set(routeId, registration.filling);
    const cacheOptions = registration.filling.getCacheOptions?.();
    if (cacheOptions) {
      registry.cacheOptions.set(routeId, cacheOptions);
    }
    registry.renderModes.set(routeId, registration.filling.getRenderMode());
  }

  // #186: pageHandlers 경로에서도 metadata / generateMetadata 캐싱
  // (pageLoaders 경로는 loadPageData에서 이미 처리됨)
  if (registration.metadata && typeof registration.metadata === "object") {
    registry.pageMetadata.set(routeId, registration.metadata);
  }
  if (typeof registration.generateMetadata === "function") {
    registry.pageGenerateMetadata.set(routeId, registration.generateMetadata);
  }

  return registration;
}

function buildRouteCacheKey(routeId: string, url: URL): string {
  const entries = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) {
      return aValue.localeCompare(bValue);
    }
    return aKey.localeCompare(bKey);
  });
  const search = entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : "";
  return `${routeId}:${url.pathname}${search}`;
}

// ---------- Main Request Dispatcher ----------

/**
 * 메인 요청 디스패처
 */
async function handleRequestInternal(
  req: Request,
  router: Router,
  registry: ServerRegistry
): Promise<Result<Response>> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const settings = registry.settings;

  // 0. CORS Preflight 요청 처리
  if (settings.cors && isPreflightRequest(req)) {
    const corsOptions: CorsOptions = typeof settings.cors === 'object' ? settings.cors : {};
    return ok(handlePreflightRequest(req, corsOptions));
  }

  // 1. 정적 파일 서빙 시도 (최우선)
  const staticFileResult = await serveStaticFile(pathname, settings, req);
  if (staticFileResult.handled) {
    const staticResponse = staticFileResult.response!;
    if (settings.cors && isCorsRequest(req)) {
      const corsOptions: CorsOptions = typeof settings.cors === 'object' ? settings.cors : {};
      return ok(applyCorsToResponse(staticResponse, req, corsOptions));
    }
    return ok(staticResponse);
  }

  // 1.5. Image optimization handler (/_mandu/image)
  if (pathname === "/_mandu/image") {
    const imageResponse = await handleImageRequest(req, settings.rootDir, settings.publicDir);
    if (imageResponse) return ok(imageResponse);
  }

  // 1.6. Internal runtime cache control endpoint
  if (pathname === INTERNAL_CACHE_ENDPOINT) {
    return ok(await handleInternalCacheControlRequest(req, settings));
  }

  // 1.7. Internal observability EventBus stream + recent snapshot
  if (pathname === INTERNAL_EVENTS_ENDPOINT) {
    return ok(handleEventsStreamRequest(req));
  }
  if (pathname === `${INTERNAL_EVENTS_ENDPOINT}/recent`) {
    return ok(handleEventsRecentRequest(req));
  }

  // 2. Kitchen dev dashboard (dev mode only)
  if (settings.isDev && pathname.startsWith(KITCHEN_PREFIX) && registry.kitchen) {
    const kitchenResponse = await registry.kitchen.handle(req, pathname);
    if (kitchenResponse) return ok(kitchenResponse);
  }

  // 3. 라우트 매칭
  const match = router.match(pathname);
  if (!match) {
    return err(createNotFoundResponse(pathname));
  }

  const { route, params } = match;

  // 3. 라우트 종류별 처리
  if (route.kind === "api") {
    const rateLimitOptions = settings.rateLimit;
    if (rateLimitOptions && registry.rateLimiter) {
      const decision = registry.rateLimiter.consume(req, route.id, rateLimitOptions);
      if (!decision.allowed) {
        return ok(createRateLimitResponse(decision, rateLimitOptions));
      }

      const apiResult = await handleApiRoute(req, route, params, registry);
      if (!apiResult.ok) return apiResult;
      return ok(appendRateLimitHeaders(apiResult.value, decision, rateLimitOptions));
    }

    return handleApiRoute(req, route, params, registry);
  }

  if (route.kind === "page") {
    return handlePageRoute(req, url, route, params, registry);
  }

  // 4. 알 수 없는 라우트 종류 — exhaustiveness check
  const _exhaustive: never = route;
  return err({
    errorType: "FRAMEWORK_BUG",
    code: "MANDU_F003",
    httpStatus: 500,
    message: `Unknown route kind: ${(_exhaustive as RouteSpec).kind}`,
    summary: "알 수 없는 라우트 종류 - 프레임워크 버그",
    fix: {
      file: ".mandu/routes.manifest.json",
      suggestion: "라우트의 kind는 'api' 또는 'page'여야 합니다",
    },
    route: { id: (_exhaustive as RouteSpec).id, pattern: (_exhaustive as RouteSpec).pattern },
    timestamp: new Date().toISOString(),
  });
}

// ========== Port Selection ==========

const MAX_PORT_ATTEMPTS = 10;

function isPortInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? "";
  return code === "EADDRINUSE" || message.includes("EADDRINUSE") || message.includes("address already in use");
}

function startBunServerWithFallback(options: {
  port: number;
  hostname?: string;
  fetch: (req: Request, server: Server<undefined>) => Promise<Response | undefined>;
  websocket?: Record<string, unknown>;
}): { server: Server<undefined>; port: number; attempts: number } {
  const { port: startPort, hostname, fetch, websocket } = options;
  let lastError: unknown = null;

  const serveOptions: Record<string, unknown> = { hostname, fetch, idleTimeout: 255 };
  if (websocket) serveOptions.websocket = websocket;

  // Port 0: let Bun/OS pick an available ephemeral port.
  if (startPort === 0) {
    const server = Bun.serve({ port: 0, ...serveOptions } as any);
    return { server, port: server.port ?? 0, attempts: 0 };
  }

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const candidate = startPort + attempt;
    if (candidate < 1 || candidate > 65535) {
      continue;
    }
    try {
      const server = Bun.serve({ port: candidate, ...serveOptions } as any);
      return { server, port: server.port ?? candidate, attempts: attempt };
    } catch (error) {
      if (!isPortInUseError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError ?? new Error(`No available port found starting at ${startPort}`);
}

// ========== Server Startup ==========

export function startServer(manifest: RoutesManifest, options: ServerOptions = {}): ManduServer {
  const {
    port = 3000,
    hostname = "localhost",
    rootDir = process.cwd(),
    isDev = false,
    hmrPort,
    bundleManifest,
    publicDir = "public",
    cors = false,
    streaming = false,
    rateLimit = false,
    cssPath: cssPathOption,
    registry = defaultRegistry,
    guardConfig = null,
    cache: cacheOption,
    managementToken,
  } = options;

  // cssPath 처리:
  // - string: 해당 경로로 <link> 주입
  // - false: CSS 링크 주입 비활성화
  // - undefined: false로 처리 (기본적으로 링크 미삽입 - 404 방지)
  //
  // dev/build에서 Tailwind 감지 시 명시적으로 cssPath 전달 필요:
  // - dev.ts: cssPath: hasTailwind ? cssWatcher?.serverPath : false
  // - 프로덕션: 빌드 후 .mandu/client/globals.css 존재 시 경로 전달
  const cssPath: string | false = cssPathOption ?? false;

  // CORS 옵션 파싱
  const corsOptions: CorsOptions | false = cors === true ? {} : cors;
  const rateLimitOptions = normalizeRateLimitOptions(rateLimit);

  if (!isDev && cors === true) {
    console.warn("⚠️  [Security Warning] CORS is set to allow all origins.");
    console.warn("   This is not recommended for production environments.");
    console.warn("   Consider specifying allowed origins explicitly:");
    console.warn("   cors: { origin: ['https://yourdomain.com'] }");
  }

  // Registry settings 저장 (초기값)
  registry.settings = {
    isDev,
    hmrPort,
    bundleManifest,
    rootDir,
    publicDir,
    cors: corsOptions,
    streaming,
    rateLimit: rateLimitOptions,
    cssPath,
    managementToken,
  };

  registry.rateLimiter = rateLimitOptions ? new MemoryRateLimiter() : null;

  // ISR/SWR 캐시 초기화
  if (cacheOption) {
    const store = cacheOption === true ? new MemoryCacheStore() : cacheOption;
    registry.settings.cacheStore = store;
    setGlobalCache(store); // revalidatePath/revalidateTag API에서 사용
  }

  // Kitchen dev dashboard (dev mode only)
  if (isDev) {
    const kitchen = new KitchenHandler({ rootDir, manifest, guardConfig });
    kitchen.start();
    registry.kitchen = kitchen;
  }

  const router = new Router(manifest.routes);

  // 글로벌 미들웨어 (middleware.ts) — 동기 로드로 첫 요청부터 보장
  let middlewareFn: MiddlewareFn | null = null;
  let middlewareConfig: MiddlewareConfig | null = null;

  const mwResult = loadMiddlewareSync(rootDir);
  if (mwResult) {
    middlewareFn = mwResult.fn;
    middlewareConfig = mwResult.config;
    console.log("🔗 Global middleware loaded");
  }

  // Fetch handler: 미들웨어 + CORS + 라우트 디스패치 (런타임 중립 팩토리 사용)
  const fetchHandler = createFetchHandler({
    router,
    registry,
    corsOptions,
    middlewareFn,
    middlewareConfig,
    handleRequest,
  });

  // WebSocket 핸들러 빌드 (등록된 WS 라우트가 있을 때만)
  const hasWsRoutes = registry.wsHandlers.size > 0;
  const wsConfig = hasWsRoutes ? {
    open(ws: any) {
      const data = ws.data as WSUpgradeData;
      const handlers = registry.wsHandlers.get(data.routeId);
      handlers?.open?.(wrapBunWebSocket(ws));
    },
    message(ws: any, message: string | ArrayBuffer) {
      const data = ws.data as WSUpgradeData;
      const handlers = registry.wsHandlers.get(data.routeId);
      handlers?.message?.(wrapBunWebSocket(ws), message);
    },
    close(ws: any, code: number, reason: string) {
      const data = ws.data as WSUpgradeData;
      const handlers = registry.wsHandlers.get(data.routeId);
      handlers?.close?.(wrapBunWebSocket(ws), code, reason);
    },
    drain(ws: any) {
      const data = ws.data as WSUpgradeData;
      const handlers = registry.wsHandlers.get(data.routeId);
      handlers?.drain?.(wrapBunWebSocket(ws));
    },
  } : undefined;

  // fetch handler: WS upgrade 감지 추가
  const wrappedFetch = hasWsRoutes
    ? async (req: Request, bunServer: Server<undefined>): Promise<Response | undefined> => {
        // WebSocket upgrade 요청 감지
        if (req.headers.get("upgrade") === "websocket") {
          const url = new URL(req.url);
          const match = router.match(url.pathname);
          if (match && registry.wsHandlers.has(match.route.id)) {
            const upgraded = (bunServer as any).upgrade(req, {
              data: { routeId: match.route.id, params: match.params, id: crypto.randomUUID() },
            });
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
          }
        }
        return fetchHandler(req);
      }
    : async (req: Request): Promise<Response> => fetchHandler(req);

  const { server, port: actualPort, attempts } = startBunServerWithFallback({
    port,
    hostname,
    fetch: wrappedFetch as any,
    websocket: wsConfig,
  });

  if (attempts > 0) {
    console.warn(`⚠️  Port ${port} is in use. Using ${actualPort} instead.`);
  }

  if (hmrPort !== undefined && hmrPort === port && actualPort !== port) {
    registry.settings = { ...registry.settings, hmrPort: actualPort };
  }

  if (isDev) {
    console.log(`🥟 Mandu Dev Server running at http://${hostname}:${actualPort}`);
    if (registry.settings.hmrPort) {
      console.log(`🔥 HMR enabled on port ${registry.settings.hmrPort + PORTS.HMR_OFFSET}`);
    }
    console.log(`📂 Static files: /${publicDir}/, /.mandu/client/`);
    if (corsOptions) {
      console.log(`🌐 CORS enabled`);
    }
    if (streaming) {
      console.log(`🌊 Streaming SSR enabled`);
    }
    if (registry.kitchen) {
      console.log(`🍳 Kitchen dashboard at http://${hostname}:${actualPort}/__kitchen`);
    }
  } else {
    console.log(`🥟 Mandu server running at http://${hostname}:${actualPort}`);
    if (streaming) {
      console.log(`🌊 Streaming SSR enabled`);
    }
  }

  return {
    server,
    router,
    registry,
    stop: () => {
      registry.kitchen?.stop();
      server.stop();
    },
  };
}

// Clear registries (useful for testing) - deprecated, use clearDefaultRegistry()
export function clearRegistry(): void {
  clearDefaultRegistry();
}

// Export registry maps for backward compatibility (defaultRegistry 사용)
export const apiHandlers = defaultRegistry.apiHandlers;
export const pageLoaders = defaultRegistry.pageLoaders;
export const pageHandlers = defaultRegistry.pageHandlers;
export const routeComponents = defaultRegistry.routeComponents;

// ========== Rate Limiting Public API ==========

/**
 * Rate limiter 인스턴스 생성
 * API 핸들러에서 직접 사용 가능
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from '@mandujs/core/runtime/server';
 *
 * const limiter = createRateLimiter({ max: 5, windowMs: 60000 });
 *
 * export async function POST(req: Request) {
 *   const decision = limiter.check(req, 'my-api-route');
 *   if (!decision.allowed) {
 *     return limiter.createResponse(decision);
 *   }
 *   // ... 정상 로직
 * }
 * ```
 */
export function createRateLimiter(options?: RateLimitOptions) {
  const normalized = normalizeRateLimitOptions(options || true);
  if (!normalized) {
    throw new Error('Rate limiter options cannot be false');
  }

  const limiter = new MemoryRateLimiter();

  return {
    /**
     * Rate limit 체크
     * @param req Request 객체 (IP 추출용)
     * @param routeId 라우트 식별자 (동일 IP라도 라우트별로 독립적인 limit)
     */
    check(req: Request, routeId: string): RateLimitDecision {
      return limiter.consume(req, routeId, normalized);
    },

    /**
     * Rate limit 초과 시 429 응답 생성
     */
    createResponse(decision: RateLimitDecision): Response {
      return createRateLimitResponse(decision, normalized);
    },

    /**
     * 정상 응답에 Rate limit 헤더 추가
     */
    addHeaders(response: Response, decision: RateLimitDecision): Response {
      return appendRateLimitHeaders(response, decision, normalized);
    },
  };
}

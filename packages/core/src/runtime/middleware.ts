/**
 * Mandu Global Middleware
 * 라우트 매칭 전에 실행되는 글로벌 미들웨어 시스템
 *
 * 프로젝트 루트의 middleware.ts 파일에서 자동 로드
 */

import { CookieManager } from "../filling/context";

// ========== Types ==========

export interface MiddlewareContext {
  /** 원본 Request */
  request: Request;
  /** 파싱된 URL */
  url: URL;
  /** Cookie 매니저 */
  cookies: CookieManager;
  /** matcher에서 추출된 파라미터 */
  params: Record<string, string>;

  /** 리다이렉트 응답 생성 */
  redirect(url: string, status?: 301 | 302 | 307 | 308): Response;
  /** JSON 응답 생성 */
  json(data: unknown, status?: number): Response;
  /** 내부 라우트 재작성 (URL 변경 없이 다른 라우트 처리) */
  rewrite(url: string): Request;

  /** 다음 핸들러에 데이터 전달 */
  set(key: string, value: unknown): void;
  /** 전달된 데이터 읽기 */
  get<T>(key: string): T | undefined;
}

export type MiddlewareNext = () => Promise<Response>;

export type MiddlewareFn = (
  ctx: MiddlewareContext,
  next: MiddlewareNext
) => Response | Promise<Response>;

export interface MiddlewareConfig {
  /** 미들웨어를 적용할 경로 패턴 */
  matcher?: string[];
  /** 제외할 경로 패턴 */
  exclude?: string[];
}

// ========== Implementation ==========

/**
 * MiddlewareContext 생성
 */
interface MiddlewareMatchResult {
  matched: boolean;
  params: Record<string, string>;
}

export interface InternalMiddlewareContext extends MiddlewareContext {
  getRewrittenRequest(): Request | null;
}

export function createMiddlewareContext(
  request: Request,
  params: Record<string, string> = {}
): InternalMiddlewareContext {
  const url = new URL(request.url);
  const cookies = new CookieManager(request);
  const store = new Map<string, unknown>();
  let rewrittenRequest: Request | null = null;

  return {
    request,
    url,
    cookies,
    params,

    redirect(target: string, status: 301 | 302 | 307 | 308 = 302): Response {
      return Response.redirect(new URL(target, url.origin).href, status);
    },

    json(data: unknown, status: number = 200): Response {
      return Response.json(data, { status });
    },

    rewrite(target: string): Request {
      const rewriteUrl = new URL(target, url.origin);
      rewrittenRequest = new Request(rewriteUrl.href, {
        method: request.method,
        headers: request.headers,
        body: request.clone().body, // 원본 request body 소비 방지
      });
      return rewrittenRequest;
    },

    set(key: string, value: unknown): void {
      store.set(key, value);
    },

    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },

    getRewrittenRequest(): Request | null {
      return rewrittenRequest;
    },
  };
}

/**
 * 경로가 matcher 패턴과 일치하는지 확인
 * :path* → 와일드카드 매칭
 */
export function matchesMiddlewarePath(
  pathname: string,
  config: MiddlewareConfig | null
): boolean {
  return getMiddlewareMatch(pathname, config).matched;
}

export function getMiddlewareMatch(
  pathname: string,
  config: MiddlewareConfig | null
): MiddlewareMatchResult {
  // config 없으면 모든 경로에 적용
  if (!config) return { matched: true, params: {} };

  // exclude 패턴 먼저 확인
  if (config.exclude) {
    for (const pattern of config.exclude) {
      if (matchPattern(pathname, pattern)) return { matched: false, params: {} };
    }
  }

  // matcher가 없으면 모든 경로에 적용
  if (!config.matcher || config.matcher.length === 0) return { matched: true, params: {} };

  // matcher 패턴 중 하나라도 일치하면 적용
  for (const pattern of config.matcher) {
    const params = matchPatternWithParams(pathname, pattern);
    if (params) {
      return { matched: true, params };
    }
  }

  return { matched: false, params: {} };
}

/**
 * 단순 경로 패턴 매칭
 * - /api/* → /api/ 하위 모든 경로
 * - /dashboard/:path* → /dashboard/ 하위 모든 경로
 * - /about → 정확히 /about
 */
function matchPattern(pathname: string, pattern: string): boolean {
  return matchPatternWithParams(pathname, pattern) !== null;
}

function matchPatternWithParams(pathname: string, pattern: string): Record<string, string> | null {
  // 와일드카드 패턴: /api/* → /api, /api/anything 모두 매칭
  if (pattern.endsWith("*") || pattern.endsWith(":path*")) {
    const prefix = pattern.replace(/[:*]path\*$/, "").replace(/\*$/, "");
    // prefix 자체 또는 prefix 하위 경로 매칭
    const normalizedPrefix = prefix.replace(/\/$/, "");
    // 정확히 prefix이거나, prefix/ 로 시작하는 경우만 매칭 (/api/* → /apikeys 매칭 방지)
    if (pathname === normalizedPrefix || pathname.startsWith(normalizedPrefix + "/")) {
      const wildcard = pathname.slice(normalizedPrefix.length).replace(/^\/+/, "");
      if (pattern.endsWith(":path*")) {
        return { path: wildcard };
      }
      return {};
    }
    return null;
  }

  const pathSegments = pathname.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length !== patternSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];

    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = pathSegment;
      continue;
    }

    if (patternSegment !== pathSegment) {
      return null;
    }
  }

  return params;
}

/**
 * middleware.ts 파일에서 미들웨어 로드 (async)
 */
export async function loadMiddleware(
  rootDir: string
): Promise<{ fn: MiddlewareFn; config: MiddlewareConfig | null } | null> {
  const possiblePaths = [
    `${rootDir}/middleware.ts`,
    `${rootDir}/middleware.js`,
  ];

  for (const mwPath of possiblePaths) {
    try {
      const file = Bun.file(mwPath);
      if (await file.exists()) {
        const mod = await import(mwPath);
        return validateMiddlewareModule(mod);
      }
    } catch (error) {
      console.warn(`[Mandu] middleware.ts 로드 실패:`, error);
    }
  }

  return null;
}

/**
 * middleware.ts 동기 로드 (서버 시작 시 사용 — 첫 요청부터 미들웨어 보장)
 */
export function loadMiddlewareSync(
  rootDir: string
): { fn: MiddlewareFn; config: MiddlewareConfig | null } | null {
  const fs = require("fs") as typeof import("fs");
  const possiblePaths = [
    `${rootDir}/middleware.ts`,
    `${rootDir}/middleware.js`,
  ];

  for (const mwPath of possiblePaths) {
    try {
      if (fs.existsSync(mwPath)) {
        // Bun에서 require()는 .ts도 동기 로드 가능
        const mod = require(mwPath);
        return validateMiddlewareModule(mod);
      }
    } catch (error) {
      console.warn(`[Mandu] middleware.ts 로드 실패:`, error);
    }
  }

  return null;
}

function validateMiddlewareModule(
  mod: Record<string, unknown>
): { fn: MiddlewareFn; config: MiddlewareConfig | null } | null {
  const fn = mod.default as MiddlewareFn;
  const config = (mod.config as MiddlewareConfig) ?? null;

  if (typeof fn !== "function") {
    console.warn(`[Mandu] middleware.ts의 default export가 함수가 아닙니다.`);
    return null;
  }

  return { fn, config };
}

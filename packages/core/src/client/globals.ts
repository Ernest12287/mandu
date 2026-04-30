import type * as __ManduReactTypes0 from "react";
/**
 * Mandu 전역 타입 선언
 * 클라이언트 측 전역 상태의 타입 정의
 */
import type { Root } from "react-dom/client";
import type { RouterState } from "./router";

interface ManduRouteInfo {
  id: string;
  pattern: string;
  params: Record<string, string>;
}

interface ManduDataEntry {
  serverData: unknown;
  timestamp?: number;
}

declare global {
  interface Window {
    /** 서버에서 전달된 데이터 (routeId → data) */
    __MANDU_DATA__?: Record<string, ManduDataEntry>;

    /** 직렬화된 서버 데이터 (raw JSON) */
    __MANDU_DATA_RAW__?: string;

    /** 현재 라우트 정보 */
    __MANDU_ROUTE__?: ManduRouteInfo;

    /** 클라이언트 라우터 상태 */
    __MANDU_ROUTER_STATE__?: RouterState;

    /** 라우터 상태 변경 리스너 */
    __MANDU_ROUTER_LISTENERS__?: Set<(state: RouterState) => void>;

    /** Hydrated roots 추적 (unmount용) */
    __MANDU_ROOTS__?: Map<string, Root>;

    /** React 인스턴스 공유 */
    __MANDU_REACT__?: typeof __ManduReactTypes0;

    /**
     * Issue #193 — global SPA navigation toggle.
     *
     *   - `undefined` (not set) → default. Plain `<a href="/about">`
     *     is intercepted and routed through the client-side router.
     *   - `false`               → legacy opt-in behavior. Only `<a>`
     *     tags with `data-mandu-link` are intercepted; all other
     *     internal links perform a full browser navigation.
     *   - `true`                → same as undefined; present only for
     *     symmetry and forward compat.
     *
     * SSR injects this global only when `mandu.config.ts` sets
     * `spa: false` — the default case emits nothing to keep the
     * typical response payload unchanged.
     */
    __MANDU_SPA__?: boolean;
  }
}



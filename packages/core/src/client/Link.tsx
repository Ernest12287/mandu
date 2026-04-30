/**
 * Mandu Link Component 🔗
 * Client-side 네비게이션을 위한 Link 컴포넌트
 */

import React, {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { navigate, prefetch } from "./router";
import { autoStableManduId } from "../runtime/stable-selector";

export interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** 이동할 URL */
  href: string;
  /** Stable selector id (optional). If omitted, core injects best-effort id. */
  manduId?: string;
  /** history.replaceState 사용 여부 */
  replace?: boolean;
  /** 마우스 hover 시 prefetch 여부 */
  prefetch?: boolean;
  /** 스크롤 위치 복원 여부 (기본: true) */
  scroll?: boolean;
  /** 자식 요소 */
  children?: ReactNode;
}

/**
 * Client-side 네비게이션 Link 컴포넌트
 *
 * @example
 * ```tsx
 * import { Link } from "@mandujs/core/client";
 *
 * // 기본 사용
 * <Link href="/about">About</Link>
 *
 * // Prefetch 활성화
 * <Link href="/users" prefetch>Users</Link>
 *
 * // Replace 모드 (뒤로가기 히스토리 없음)
 * <Link href="/login" replace>Login</Link>
 * ```
 */
export function Link({
  href,
  manduId,
  replace = false,
  prefetch: shouldPrefetch = false,
  scroll = true,
  children,
  onClick,
  onMouseEnter,
  onFocus,
  ...rest
}: LinkProps): React.ReactElement {
  const prefetchedRef = useRef(false);

  // 클릭 핸들러
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // 사용자 정의 onClick 먼저 실행
      onClick?.(event);

      // 기본 동작 방지 조건
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey
      ) {
        return;
      }

      // 외부 링크 체크
      try {
        const url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin) {
          return; // 외부 링크는 기본 동작
        }
      } catch {
        return;
      }

      // Client-side 네비게이션
      event.preventDefault();
      void navigate(href, { replace, scroll });
    },
    [href, replace, scroll, onClick]
  );

  // Prefetch 실행
  const doPrefetch = useCallback(() => {
    if (!shouldPrefetch || prefetchedRef.current) return;

    try {
      const url = new URL(href, window.location.origin);
      if (url.origin === window.location.origin) {
        void prefetch(href);
        prefetchedRef.current = true;
      }
    } catch {
      // 무시
    }
  }, [href, shouldPrefetch]);

  // 마우스 hover 핸들러
  const handleMouseEnter = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onMouseEnter?.(event);
      doPrefetch();
    },
    [onMouseEnter, doPrefetch]
  );

  // 포커스 핸들러 (키보드 네비게이션)
  const handleFocus = useCallback(
    (event: React.FocusEvent<HTMLAnchorElement>) => {
      onFocus?.(event);
      doPrefetch();
    },
    [onFocus, doPrefetch]
  );

  // Viewport 진입 시 prefetch (IntersectionObserver)
  useEffect(() => {
    if (!shouldPrefetch || typeof IntersectionObserver === "undefined") {
      return;
    }

    // ref가 없으면 무시 (SSR)
    return;
  }, [shouldPrefetch]);

  const stableId = manduId ?? autoStableManduId("Link");

  return (
    <a
      href={href}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onFocus={handleFocus}
      data-mandu-link=""
      data-mandu-id={stableId}
      {...rest}
    >
      {children}
    </a>
  );
}

/**
 * NavLink - 현재 경로와 일치할 때 활성 스타일 적용
 *
 * @example
 * ```tsx
 * import { NavLink } from "@mandujs/core/client";
 *
 * <NavLink
 *   href="/about"
 *   className={({ isActive }) => isActive ? "active" : ""}
 * >
 *   About
 * </NavLink>
 * ```
 */
export interface NavLinkProps extends Omit<LinkProps, "className" | "style"> {
  /** 활성 상태에 따른 className */
  className?: string | ((props: { isActive: boolean }) => string);
  /** 활성 상태에 따른 style */
  style?:
    | React.CSSProperties
    | ((props: { isActive: boolean }) => React.CSSProperties);
  /** 활성 상태일 때 적용할 style (style과 병합됨) */
  activeStyle?: React.CSSProperties;
  /** 활성 상태일 때 추가할 className */
  activeClassName?: string;
  /** 정확히 일치해야 활성화 (기본: false) */
  exact?: boolean;
}

export function NavLink({
  href,
  className,
  style,
  activeStyle,
  activeClassName,
  exact = false,
  ...rest
}: NavLinkProps): React.ReactElement {
  // 현재 경로와 비교
  const isActive =
    typeof window !== "undefined"
      ? exact
        ? window.location.pathname === href
        : window.location.pathname.startsWith(href)
      : false;

  // className 처리
  let resolvedClassName =
    typeof className === "function" ? className({ isActive }) : className;

  if (isActive && activeClassName) {
    resolvedClassName = resolvedClassName
      ? `${resolvedClassName} ${activeClassName}`
      : activeClassName;
  }

  // style 처리
  let resolvedStyle =
    typeof style === "function" ? style({ isActive }) : style;

  if (isActive && activeStyle) {
    resolvedStyle = { ...resolvedStyle, ...activeStyle };
  }

  return (
    <Link
      href={href}
      className={resolvedClassName}
      style={resolvedStyle}
      {...rest}
    />
  );
}

export default Link;

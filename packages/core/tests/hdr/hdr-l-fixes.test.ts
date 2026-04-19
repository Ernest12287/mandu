/**
 * Phase 7.3 B — Security Low findings unit tests (router-side).
 *
 * Covers L-01 and L-03 from the Phase 7.2 audit
 * (docs/security/phase-7-2-audit.md §3). L-02 tests live in
 * `packages/cli/tests/commands/dev-mask-slot-path.test.ts` (pure-node path),
 * and L-04 lives in `packages/core/tests/server/hdr-header-echo.test.ts`
 * (no happy-dom because happy-dom's fetch shim chokes on Bun.serve).
 *
 *   L-01 — applyHDRUpdate rejects malformed loader payloads so a
 *          server/client contract skew can't crash React inside
 *          startTransition with an unhelpful `undefined.x` fault deep
 *          in the fiber reconciler.
 *   L-03 — window.__MANDU_ROUTER_REVALIDATE__ is installed ONLY in
 *          dev. In prod the hook is pure attack surface — an XSS
 *          payload could hijack it to coerce router state — and has
 *          no legitimate caller (the HMR client script is dev-only).
 *
 * References:
 *   docs/security/phase-7-2-audit.md §3 (L-01 / L-03 details)
 *   packages/core/src/client/router.ts — isValidHDRLoaderData,
 *     applyHDRUpdate, shouldInstallHDRHook
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { setupHappyDom } from "../setup";

setupHappyDom();

// Import AFTER happy-dom boot so the router module finds a live window.
import {
  initializeRouter,
  cleanupRouter,
  getRouterState,
  getLoaderData,
  isValidHDRLoaderData,
  _testOnly_applyHDRUpdate,
} from "../../src/client/router";
import {
  setServerData,
  getServerData,
} from "../../src/client/window-state";

type ManduWindow = Window & {
  __MANDU_ROUTE__?: {
    id: string;
    pattern: string;
    params: Record<string, string>;
  };
  __MANDU_DATA__?: Record<string, { serverData: unknown }>;
  __MANDU_ROUTER_STATE__?: unknown;
  __MANDU_ROUTER_LISTENERS__?: Set<(state: unknown) => void>;
  __MANDU_ROUTER_REVALIDATE__?: (routeId: string, loaderData: unknown) => void;
};

function getManduWindow(): ManduWindow {
  return window as unknown as ManduWindow;
}

function seedRouterState(
  routeId: string,
  initialData: unknown,
  pattern = "/test",
): string {
  const w = getManduWindow();
  w.__MANDU_ROUTE__ = { id: routeId, pattern, params: {} };
  w.__MANDU_DATA__ = { [routeId]: { serverData: initialData } };
  w.__MANDU_ROUTER_STATE__ = undefined;
  w.__MANDU_ROUTER_LISTENERS__ = new Set();
  w.__MANDU_ROUTER_REVALIDATE__ = undefined;
  initializeRouter();
  return routeId;
}

function resetRouter(): void {
  cleanupRouter();
  const w = getManduWindow();
  w.__MANDU_ROUTE__ = undefined;
  w.__MANDU_DATA__ = undefined;
  w.__MANDU_ROUTER_STATE__ = undefined;
  w.__MANDU_ROUTER_LISTENERS__ = undefined;
  w.__MANDU_ROUTER_REVALIDATE__ = undefined;
  document.body.innerHTML = "";
}

/**
 * Narrow wrapper so TypeScript treats the return as `unknown` (not
 * `T | undefined`). Without this, `expect(loader()).toEqual(obj)`
 * trips TS 5.x "{...} does not assign to undefined" overload quirk.
 */
function loader(): unknown {
  return getLoaderData();
}


// -----------------------------------------------------------------------------
// L-01 — applyHDRUpdate schema validation.
// -----------------------------------------------------------------------------

describe("Phase 7.3 L-01 — applyHDRUpdate schema validation", () => {
  beforeEach(() => {
    resetRouter();
  });
  afterEach(() => {
    resetRouter();
  });

  // ───────────────────────────────────────────────────────────────────
  // 1. The predicate is the whole contract. Lock its behaviour down so
  //    a bundler rewrite or refactor can't silently widen acceptance.
  // ───────────────────────────────────────────────────────────────────

  test("[1] isValidHDRLoaderData accepts null + plain objects, rejects primitives + arrays", () => {
    // Positive — legitimate loader returns.
    expect(isValidHDRLoaderData(null)).toBe(true);
    expect(isValidHDRLoaderData({})).toBe(true);
    expect(isValidHDRLoaderData({ count: 1 })).toBe(true);
    expect(isValidHDRLoaderData({ nested: { deep: [1, 2, 3] } })).toBe(true);
    // Date etc. — typeof "object", loader might pass one through.
    expect(isValidHDRLoaderData(new Date())).toBe(true);

    // Negative — contract drift signals, must be rejected.
    expect(isValidHDRLoaderData(undefined)).toBe(false);
    expect(isValidHDRLoaderData("string")).toBe(false);
    expect(isValidHDRLoaderData(42)).toBe(false);
    expect(isValidHDRLoaderData(true)).toBe(false);
    expect(isValidHDRLoaderData(false)).toBe(false);
    // Arrays are object-typed but not a valid loader shape.
    expect(isValidHDRLoaderData([])).toBe(false);
    expect(isValidHDRLoaderData([{ count: 1 }])).toBe(false);
    expect(isValidHDRLoaderData([1, 2, 3])).toBe(false);
  });

  test("[2] valid plain-object loader payload is applied (happy path preserved)", () => {
    const routeId = seedRouterState("home", { count: 0 });
    const beforeRoute = getRouterState().currentRoute;
    expect(beforeRoute?.id).toBe(routeId);
    expect(loader()).toEqual({ count: 0 });

    _testOnly_applyHDRUpdate(routeId, { count: 42, greet: "world" });

    expect(loader()).toEqual({ count: 42, greet: "world" });
    expect(getRouterState().currentRoute?.id).toBe(routeId);
  });

  test("[3] array payload is rejected — loaderData unchanged, console.warn fired", () => {
    const routeId = seedRouterState("home", { count: 0 });
    const original = loader();

    const originalWarn = console.warn;
    let warnCount = 0;
    let warnMessage = "";
    console.warn = (msg: unknown) => {
      warnCount++;
      warnMessage = String(msg);
    };

    try {
      _testOnly_applyHDRUpdate(routeId, [1, 2, 3] as unknown);
    } finally {
      console.warn = originalWarn;
    }

    expect(loader()).toEqual(original);
    expect(warnCount).toBe(1);
    expect(warnMessage).toContain("applyHDRUpdate");
    expect(warnMessage).toContain("array");
  });

  test("[4] string payload is rejected — loaderData unchanged", () => {
    const routeId = seedRouterState("home", { count: 0 });
    const original = loader();

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      _testOnly_applyHDRUpdate(routeId, "hello" as unknown);
    } finally {
      console.warn = originalWarn;
    }
    expect(loader()).toEqual(original);
  });

  test("[5] undefined payload is rejected — loaderData unchanged", () => {
    const routeId = seedRouterState("home", { count: 0 });
    const original = loader();

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      _testOnly_applyHDRUpdate(routeId, undefined);
    } finally {
      console.warn = originalWarn;
    }
    expect(loader()).toEqual(original);
  });

  test("[6] explicit null loader payload IS accepted (valid contract)", () => {
    const routeId = seedRouterState("home", { count: 0 });
    _testOnly_applyHDRUpdate(routeId, null);
    expect(loader()).toBeNull();
    expect(getServerData(routeId)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// L-03 — dev-only __MANDU_ROUTER_REVALIDATE__.
//
// The router module is compiled once and bundled into both dev and prod
// client bundles. In a real prod build the bundler replaces
// `process.env.NODE_ENV` with the literal "production" (see
// `packages/core/src/bundler/build.ts` define option), so the `if` body
// that installs the hook is dead-code-eliminated.
//
// Under bun:test we exercise the runtime predicate that the DCE gates
// on — flipping `process.env.NODE_ENV` before calling initializeRouter.
// -----------------------------------------------------------------------------

describe("Phase 7.3 L-03 — window.__MANDU_ROUTER_REVALIDATE__ dev gating", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    resetRouter();
  });
  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
    resetRouter();
  });

  test("[7] in dev/test environment the HDR hook IS installed on window", () => {
    process.env.NODE_ENV = "development";
    seedRouterState("home", { count: 0 });
    const w = getManduWindow();
    expect(typeof w.__MANDU_ROUTER_REVALIDATE__).toBe("function");
  });

  test("[8] in production the HDR hook is NOT installed (XSS surface reduction)", () => {
    process.env.NODE_ENV = "production";
    seedRouterState("home", { count: 0 });
    const w = getManduWindow();
    expect(w.__MANDU_ROUTER_REVALIDATE__).toBeUndefined();
  });

  test("[9] cleanupRouter removes the HDR hook from window", () => {
    process.env.NODE_ENV = "development";
    seedRouterState("home", { count: 0 });
    const w = getManduWindow();
    expect(typeof w.__MANDU_ROUTER_REVALIDATE__).toBe("function");

    cleanupRouter();
    expect(w.__MANDU_ROUTER_REVALIDATE__).toBeUndefined();
  });
});

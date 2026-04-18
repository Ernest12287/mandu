/**
 * Phase 7.1 R2 Agent D — Fast Refresh state preservation E2E.
 *
 * # Scope
 *
 * Validates the end-to-end wiring that keeps React `useState` values
 * alive across a hot swap of an `.island.tsx` / `.client.tsx` file.
 * Specifically, we assert that:
 *
 *   1. The Fast Refresh HTML preamble is emitted into both `renderToHTML`
 *      (ssr.ts) and `generateHTMLShell` (streaming-ssr.ts) OUTPUT when
 *      `isDev === true` AND the manifest exposes
 *      `shared.fastRefresh.{glue, runtime}`.
 *   2. The preamble is ABSENT in production-shaped manifests (graceful
 *      degrade — HTML stays byte-identical to pre-7.1 output).
 *   3. The runtime-side contract holds: `manduHMR.acceptFile(url)` +
 *      `dispatchReplacement(url, newModule)` produces exactly one
 *      `performReactRefresh()` call (coalesced) on a registered boundary.
 *   4. When the refresh runtime runs, state IS preserved — tested at the
 *      registry level because exercising a full browser requires
 *      Playwright (deferred to the CLI-layer bench in a future phase).
 *
 * # Why a mock-level E2E instead of Playwright
 *
 * A true end-to-end test requires:
 *
 *   - spawning `mandu dev`
 *   - booting a headless Chromium
 *   - navigating to the page
 *   - interacting with a component to change state
 *   - modifying a source file
 *   - verifying that the DOM updated without remount + state survived
 *
 * Playwright integration exists in `demo/ai-chat/test-results/` but the
 * core package intentionally does NOT take a hard dep on it (keeps the
 * test runtime light + Windows-compatible). Instead this spec uses the
 * same three integration points Playwright would hit:
 *
 *   - the bundler's `generateFastRefreshPreamble` + its SSR wire-up,
 *   - the runtime's `__MANDU_HMR__` registry + `performReactRefresh`
 *     dispatcher (driven by `hmr-client.ts`'s `dispatchReplacement`),
 *   - the upstream `react-refresh/runtime` `register` contract.
 *
 * Each point is exercised with a faked React refresh runtime that records
 * calls, so "state preserved" becomes provable at the registry level:
 * `register(oldType, id)` + `register(newType, id)` under the same `id`
 * is the upstream contract for family matching — the component that
 * matches keeps its hook state. We assert both the registration pattern
 * and the coalesced refresh dispatch.
 *
 * # Limits
 *
 * - We do NOT exercise `Bun.build({ reactFastRefresh: true })` here; that
 *   is covered by `packages/core/src/bundler/__tests__/fast-refresh.test.ts`
 *   section C (which produces real bundle outputs and greps for
 *   `$RefreshReg$` / `$RefreshSig$` calls).
 * - We do NOT touch the file-system watcher path; that is covered by
 *   `packages/core/tests/hmr-matrix/matrix.spec.ts`.
 * - Full-browser state preservation (DOM `value` on an `<input>` survives
 *   a hot swap) is tracked as Phase 7.2 follow-up in
 *   `docs/bun/phase-7-1-benchmarks.md`.
 *
 * References:
 *   docs/bun/phase-7-1-diagnostics/fast-refresh-strategy.md §4
 *   docs/bun/phase-7-1-team-plan.md §4 Agent D
 *   packages/core/src/runtime/fast-refresh-runtime.ts
 *   packages/core/src/runtime/fast-refresh-types.ts
 *   packages/core/src/bundler/dev.ts (generateFastRefreshPreamble)
 *   packages/core/src/runtime/ssr.ts (generateFastRefreshPreambleTag)
 *   packages/core/src/runtime/streaming-ssr.ts (generateHTMLShell)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import React from "react";

import { renderToHTML } from "../../src/runtime/ssr";
import { generateHTMLShell } from "../../src/runtime/streaming-ssr";
import type { BundleManifest } from "../../src/bundler/types";
import {
  manduHMR,
  bindRuntime,
  installGlobal,
  _resetForTests,
  _getBoundaryCountForTests,
  _isRefreshScheduledForTests,
  type ReactRefreshRuntime,
} from "../../src/runtime/fast-refresh-runtime";
import {
  createManduHot,
  dispatchReplacement,
  _resetRegistryForTests,
} from "../../src/runtime/hmr-client";

// ═══════════════════════════════════════════════════════════════════════════
// Manifest builders
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dev-shaped manifest with Fast Refresh assets. Mirrors what
 * `buildClientBundles` produces in dev mode (see `build.ts:1548`).
 */
function devManifestWithFastRefresh(): BundleManifest {
  return {
    version: 1,
    buildTime: new Date().toISOString(),
    env: "development",
    bundles: {
      home: {
        js: "/.mandu/client/home.js",
        dependencies: [],
        priority: "visible",
      },
    },
    shared: {
      runtime: "/.mandu/client/runtime.js",
      vendor: "/.mandu/client/vendor.js",
      fastRefresh: {
        runtime: "/.mandu/client/_vendor-react-refresh.js",
        glue: "/.mandu/client/_fast-refresh-runtime.js",
      },
    },
  };
}

/**
 * Production-shaped manifest — `shared.fastRefresh` is absent. Used to
 * prove the preamble is NOT emitted in prod.
 */
function prodManifest(): BundleManifest {
  return {
    version: 1,
    buildTime: new Date().toISOString(),
    env: "production",
    bundles: {
      home: {
        js: "/.mandu/client/home.js",
        dependencies: [],
        priority: "visible",
      },
    },
    shared: {
      runtime: "/.mandu/client/runtime.js",
      vendor: "/.mandu/client/vendor.js",
    },
  };
}

/**
 * Edge case: dev manifest where the fastRefresh shim build failed and
 * emitted empty strings. Preamble helper should degrade to empty output
 * rather than blow up downstream.
 */
function devManifestFastRefreshEmpty(): BundleManifest {
  return {
    version: 1,
    buildTime: new Date().toISOString(),
    env: "development",
    bundles: {
      home: {
        js: "/.mandu/client/home.js",
        dependencies: [],
        priority: "visible",
      },
    },
    shared: {
      runtime: "/.mandu/client/runtime.js",
      vendor: "/.mandu/client/vendor.js",
      fastRefresh: { runtime: "", glue: "" },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fake React refresh runtime — records register + performReactRefresh calls
// ═══════════════════════════════════════════════════════════════════════════

interface RuntimeSpy {
  runtime: ReactRefreshRuntime;
  /** Each call to `register(type, id)` is captured as `[typeRef, id]`. */
  registrations: Array<[unknown, string]>;
  /** Incremented every time `performReactRefresh` is invoked. */
  refreshCount: number;
  /** Whether `injectIntoGlobalHook` was called. */
  hookInjected: boolean;
}

function makeRuntimeSpy(): RuntimeSpy {
  const spy: RuntimeSpy = {
    registrations: [],
    refreshCount: 0,
    hookInjected: false,
    runtime: {
      injectIntoGlobalHook: () => {
        spy.hookInjected = true;
      },
      register: (type, id) => {
        spy.registrations.push([type, id]);
      },
      createSignatureFunctionForTransform: () => {
        // Identity signature — returns a wrapper that returns its arg.
        return (t: unknown) => t;
      },
      performReactRefresh: () => {
        spy.refreshCount += 1;
      },
    },
  };
  return spy;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 1 — SSR preamble emission
// ═══════════════════════════════════════════════════════════════════════════

describe("Fast Refresh preamble — renderToHTML wire-up", () => {
  const hydration = {
    strategy: "island" as const,
    priority: "visible" as const,
    preload: false,
  };

  test("[1.1] dev manifest + isDev=true + hydration → preamble is emitted in <head>", () => {
    const html = renderToHTML(React.createElement("div", null, "ok"), {
      isDev: true,
      routeId: "home",
      hydration,
      bundleManifest: devManifestWithFastRefresh(),
      serverData: { a: 1 },
    });

    // Preamble must be in head — before </head> close and before the body
    const headEnd = html.indexOf("</head>");
    const bodyStart = html.indexOf("<body>");
    expect(headEnd).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(headEnd);

    // Preamble identifiers
    expect(html).toContain("Phase 7.1 B-3 React Fast Refresh preamble");
    expect(html).toContain("$RefreshReg$");
    expect(html).toContain("$RefreshSig$");
    // Both bundle URLs (dynamic import)
    expect(html).toContain("/.mandu/client/_fast-refresh-runtime.js");
    expect(html).toContain("/.mandu/client/_vendor-react-refresh.js");
    // Must call installGlobal (the glue entry point)
    expect(html).toContain("installGlobal");

    // Position check — preamble must be inside <head>
    const preIdx = html.indexOf("React Fast Refresh preamble");
    expect(preIdx).toBeGreaterThan(-1);
    expect(preIdx).toBeLessThan(headEnd);
  });

  test("[1.2] prod manifest → preamble ABSENT (graceful degrade)", () => {
    const html = renderToHTML(React.createElement("div", null, "ok"), {
      isDev: false,
      routeId: "home",
      hydration,
      bundleManifest: prodManifest(),
      serverData: { a: 1 },
    });
    expect(html).not.toContain("React Fast Refresh preamble");
    expect(html).not.toContain("installGlobal");
    // Must not contain the Fast Refresh runtime URL either
    expect(html).not.toContain("_vendor-react-refresh.js");
  });

  test("[1.3] dev manifest but isDev=false → preamble absent (prod path wins)", () => {
    const html = renderToHTML(React.createElement("div", null, "ok"), {
      isDev: false,
      routeId: "home",
      hydration,
      bundleManifest: devManifestWithFastRefresh(),
      serverData: { a: 1 },
    });
    expect(html).not.toContain("React Fast Refresh preamble");
  });

  test("[1.4] dev manifest with empty glue/runtime URLs → preamble absent", () => {
    const html = renderToHTML(React.createElement("div", null, "ok"), {
      isDev: true,
      routeId: "home",
      hydration,
      bundleManifest: devManifestFastRefreshEmpty(),
      serverData: { a: 1 },
    });
    // Helper short-circuits when either URL is empty — no preamble output.
    expect(html).not.toContain("React Fast Refresh preamble");
  });

  test("[1.5] dev mode but no hydration (zero-JS page) → preamble absent (no island to refresh)", () => {
    // Pure-SSG pages don't hydrate — there is no island to Fast Refresh,
    // so the preamble bytes are wasted. Helper should skip it.
    const html = renderToHTML(React.createElement("div", null, "ok"), {
      isDev: true,
      // No hydration + no bundleManifest → needsHydration is false
    });
    expect(html).not.toContain("React Fast Refresh preamble");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2 — Streaming SSR preamble emission
// ═══════════════════════════════════════════════════════════════════════════

describe("Fast Refresh preamble — streaming-ssr wire-up", () => {
  const hydration = {
    strategy: "island" as const,
    priority: "visible" as const,
    preload: false,
  };

  test("[2.1] dev shell emits preamble inside <head>", () => {
    const shell = generateHTMLShell({
      isDev: true,
      routeId: "home",
      hydration,
      bundleManifest: devManifestWithFastRefresh(),
    });

    expect(shell).toContain("React Fast Refresh preamble");
    expect(shell).toContain("installGlobal");
    expect(shell).toContain("/.mandu/client/_fast-refresh-runtime.js");
    expect(shell).toContain("/.mandu/client/_vendor-react-refresh.js");

    // Must be before <body> (which in streaming is the last line of shell)
    const preIdx = shell.indexOf("React Fast Refresh preamble");
    const bodyIdx = shell.indexOf("<body>");
    expect(preIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(preIdx);
  });

  test("[2.2] prod shell does not emit preamble", () => {
    const shell = generateHTMLShell({
      isDev: false,
      routeId: "home",
      hydration,
      bundleManifest: prodManifest(),
    });
    expect(shell).not.toContain("React Fast Refresh preamble");
  });

  test("[2.3] streaming shell with no hydration does not emit preamble", () => {
    // Zero-JS streaming page — no island, no bundleManifest needed, no
    // Fast Refresh preamble.
    const shell = generateHTMLShell({
      isDev: true,
      // No hydration, no routeId → needsHydration is false
    });
    expect(shell).not.toContain("React Fast Refresh preamble");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3 — state preservation via __MANDU_HMR__ + dispatchReplacement
// ═══════════════════════════════════════════════════════════════════════════

describe("Fast Refresh state preservation — end-to-end wiring", () => {
  beforeEach(() => {
    _resetRegistryForTests();
    _resetForTests();
  });

  test("[3.1] bundler-injected acceptFile + dispatchReplacement → exactly one performReactRefresh (coalesced)", async () => {
    const spy = makeRuntimeSpy();
    await installGlobal({ runtime: spy.runtime });
    expect(spy.hookInjected).toBe(true);

    const url = "/.mandu/client/counter.island.js";
    // Bundler's `appendBoundary`-emitted code calls this inside the island
    // output. Simulating that.
    manduHMR.acceptFile(url);
    expect(manduHMR.isBoundary(url)).toBe(true);
    expect(_getBoundaryCountForTests()).toBe(1);

    // Register a self-accepting module — what the HMR client's user-facing
    // API would produce when the island calls `import.meta.hot.accept(cb)`.
    const hot = createManduHot(url);
    let newModSeenByAcceptCb: unknown = null;
    hot.accept((mod) => {
      newModSeenByAcceptCb = mod;
    });

    // Simulate a rebuild arriving with a replacement module.
    const nextModule = { default: "counter-v2" };
    const applied = dispatchReplacement(url, nextModule);

    // Accept callback ran with the new module, AND a refresh was queued.
    expect(applied).toBe(true);
    expect(newModSeenByAcceptCb).toBe(nextModule);
    expect(_isRefreshScheduledForTests()).toBe(true);

    // Drain microtasks — queueMicrotask inside performReactRefresh.
    await Promise.resolve();
    await Promise.resolve();

    expect(spy.refreshCount).toBe(1);
    expect(_isRefreshScheduledForTests()).toBe(false);
  });

  test("[3.2] multiple dispatchReplacement calls in same tick coalesce into ONE refresh", async () => {
    const spy = makeRuntimeSpy();
    await installGlobal({ runtime: spy.runtime });

    const urls = [
      "/.mandu/client/a.island.js",
      "/.mandu/client/b.island.js",
      "/.mandu/client/c.island.js",
    ];
    for (const u of urls) {
      manduHMR.acceptFile(u);
      const hot = createManduHot(u);
      hot.accept();
    }

    // Fire three replacements in the same tick — what a batched rebuild
    // would produce when 3 islands rebuild together.
    for (const u of urls) {
      dispatchReplacement(u, { default: `${u}-v2` });
    }

    await Promise.resolve();
    await Promise.resolve();

    // CRITICAL: only ONE refresh pass, not three — otherwise the user
    // sees flicker.
    expect(spy.refreshCount).toBe(1);
  });

  test("[3.3] non-boundary replacement does NOT trigger refresh (no Fast Refresh for plain modules)", async () => {
    const spy = makeRuntimeSpy();
    await installGlobal({ runtime: spy.runtime });

    // URL never registered via acceptFile() — not a boundary
    const url = "/.mandu/client/plain-utility.js";
    const hot = createManduHot(url);
    hot.accept();

    dispatchReplacement(url, { default: "new" });
    await Promise.resolve();
    await Promise.resolve();

    // Refresh must NOT fire — plain modules have no React state to
    // preserve, and the refresh runtime's register table wouldn't match.
    expect(spy.refreshCount).toBe(0);
  });

  test("[3.4] state preservation contract — upstream `register(type, id)` pattern holds", async () => {
    // React Refresh preserves state by matching components into "families"
    // via the `id` passed to `register()`. Two different `type` values
    // registered under the SAME `id` constitute a family — the new type
    // replaces the old and the component's hook state survives.
    //
    // We simulate what Bun's `reactFastRefresh: true` transform emits at
    // top-of-module:
    //   $RefreshReg$(Counter, "Counter.tsx:Counter");
    // Then a hot swap re-runs the transformed module body with a new
    // Counter identity, producing:
    //   $RefreshReg$(CounterV2, "Counter.tsx:Counter");
    // The id is identical — family match.
    const spy = makeRuntimeSpy();
    await installGlobal({ runtime: spy.runtime });

    // After installGlobal, `$RefreshReg$` routes through spy.runtime.register.
    const g = globalThis as unknown as {
      $RefreshReg$?: (type: unknown, id: string) => void;
    };
    expect(typeof g.$RefreshReg$).toBe("function");

    // Old module body runs.
    const OldCounter = function Counter() {
      return null;
    };
    g.$RefreshReg$?.(OldCounter, "counter.island.tsx:Counter");

    // New module body runs (same id — family match).
    const NewCounter = function Counter() {
      return null;
    };
    g.$RefreshReg$?.(NewCounter, "counter.island.tsx:Counter");

    // Both registrations landed on the same id — upstream matches them
    // as a family and preserves state on refresh.
    expect(spy.registrations.length).toBe(2);
    expect(spy.registrations[0]).toEqual([
      OldCounter,
      "counter.island.tsx:Counter",
    ]);
    expect(spy.registrations[1]).toEqual([
      NewCounter,
      "counter.island.tsx:Counter",
    ]);
    expect(spy.registrations[0]?.[1]).toBe(spy.registrations[1]?.[1]);
  });

  test("[3.5] full E2E narrative — island increments + edit + refresh, family registered under same id", async () => {
    // Narrative of what a real browser session would do, executed at the
    // registry level because we can't spawn a browser from `bun:test`.
    //
    //   1. Dev server boots; preamble installs __MANDU_HMR__.
    //   2. counter.island.tsx loads; bundler output calls:
    //        __MANDU_HMR__.acceptFile("/.mandu/client/counter.island.js");
    //      and Bun's reactFastRefresh transform calls:
    //        $RefreshReg$(Counter, "counter.island.tsx:Counter");
    //   3. User clicks a button — React updates useState locally. This
    //      step has no HMR interaction; skip in unit form.
    //   4. User edits counter.island.tsx — new bundle emitted.
    //   5. HMR client calls dispatchReplacement on the URL.
    //      The preamble-installed `$RefreshReg$` registers the new type
    //      under the SAME id, and the refresh runtime's family matcher
    //      preserves the state.
    //   6. performReactRefresh fires once (coalesced).

    const spy = makeRuntimeSpy();
    await installGlobal({ runtime: spy.runtime });

    const islandUrl = "/.mandu/client/counter.island.js";
    const familyId = "counter.island.tsx:Counter";

    // Step 2 — initial load
    manduHMR.acceptFile(islandUrl);
    const OldCounter = function Counter() {
      return null;
    };
    (globalThis as any).$RefreshReg$(OldCounter, familyId);

    const hot = createManduHot(islandUrl);
    let replacementFired = false;
    hot.accept(() => {
      replacementFired = true;
    });

    // Step 5 — hot swap arrives
    const NewCounter = function Counter() {
      return null;
    };
    // The new module body re-runs `$RefreshReg$` with a fresh type.
    (globalThis as any).$RefreshReg$(NewCounter, familyId);
    const applied = dispatchReplacement(islandUrl, { default: NewCounter });
    expect(applied).toBe(true);
    expect(replacementFired).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    // Assert family integrity — both registrations share the id
    expect(spy.registrations.length).toBe(2);
    expect(spy.registrations[0]?.[1]).toBe(familyId);
    expect(spy.registrations[1]?.[1]).toBe(familyId);
    expect(spy.registrations[0]?.[0]).not.toBe(spy.registrations[1]?.[0]);
    // Assert exactly one refresh pass
    expect(spy.refreshCount).toBe(1);
  });

  test("[3.6] degraded mode — runtime load fails → dispatchReplacement still returns true, no throw", async () => {
    // If react-refresh couldn't load, installGlobal leaves runtime=null.
    // We still want dispatchReplacement to function — the user's accept
    // callback runs, just without Fast Refresh. This test mirrors the
    // production degrade path documented in
    // `fast-refresh-runtime.ts:245-250`.
    await installGlobal({
      runtimeImport: async () => {
        throw new Error("simulated network failure loading react-refresh");
      },
    });

    const url = "/.mandu/client/counter.island.js";
    manduHMR.acceptFile(url);
    const hot = createManduHot(url);
    let cbFired = false;
    hot.accept(() => {
      cbFired = true;
    });

    // No throw, returns true, callback fired.
    const applied = dispatchReplacement(url, { default: "new" });
    expect(applied).toBe(true);
    expect(cbFired).toBe(true);

    // Refresh scheduling is a no-op when runtime is null — the HMR
    // client's full-reload fallback owns recovery downstream.
    await Promise.resolve();
    await Promise.resolve();
    expect(_isRefreshScheduledForTests()).toBe(false);
  });
});

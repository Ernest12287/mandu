/**
 * Issue #191 + #259 — DevTools bundle injection policy
 *
 * The ~1.15 MB `_devtools.js` bundle (React dev runtime + Kitchen panel)
 * is injected by default in dev mode regardless of whether the route
 * has islands. #259 reverted #191's "skip when no islands" heuristic
 * because SSR-only landing/marketing pages were the exact place where
 * Kitchen panels were most needed. The 1.15 MB cost is dev-only — prod
 * builds never emit `_devtools.js`. Users can still set
 * `dev.devtools: false` to opt out on a per-app basis.
 *
 * Covers:
 *   1. Decision matrix for `shouldInjectDevtools(devtools, manifest)`
 *      (pure function — table-tested without touching React).
 *   2. URL shape — `/.mandu/client/_devtools.js?v=<buildTime>` with
 *      cache-bust. `manifest.buildTime` preferred when present,
 *      `?t=Date.now()` fallback otherwise.
 *   3. End-to-end through `renderToHTML`:
 *      - hasIslands: false + no override       → present (#259 default)
 *      - hasIslands: false + devtools: true    → present (forced)
 *      - hasIslands: false + devtools: false   → absent (opt-out)
 *      - hasIslands: true                      → present (default)
 *      - hasIslands: true + devtools: false    → absent (opt-out)
 *      - prod (isDev: false) + devtools: true  → absent (prod no-op)
 *   4. Streaming SSR parity — both SSR paths must agree.
 *   5. Cache-bust query present in injected script URL.
 */
import { describe, it, expect } from "bun:test";
import React from "react";
import {
  renderToHTML,
  _testOnly_shouldInjectDevtools,
  _testOnly_generateDevtoolsScript,
} from "../../src/runtime/ssr";
import {
  _testOnly_shouldInjectDevtoolsStreaming,
  _testOnly_generateStreamingDevtoolsScript,
} from "../../src/runtime/streaming-ssr";
import type { BundleManifest } from "../../src/bundler/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyManifest(buildTime = "2026-04-19T12:00:00.000Z"): BundleManifest {
  return {
    version: 1,
    buildTime,
    env: "development",
    bundles: {},
    shared: {
      runtime: "/.mandu/client/runtime.js",
      vendor: "/.mandu/client/vendor.js",
    },
  };
}

function manifestWithIsland(
  routeId = "home",
  buildTime = "2026-04-19T12:00:00.000Z"
): BundleManifest {
  return {
    version: 1,
    buildTime,
    env: "development",
    bundles: {
      [routeId]: {
        js: `/.mandu/client/${routeId}.js`,
        dependencies: [],
        priority: "visible",
      },
    },
    islands: {
      counter: {
        js: `/.mandu/client/counter.island.js`,
        route: routeId,
        priority: "visible",
      },
    },
    shared: {
      runtime: "/.mandu/client/runtime.js",
      vendor: "/.mandu/client/vendor.js",
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Decision matrix (pure function — no React)
// ---------------------------------------------------------------------------

describe("shouldInjectDevtools — decision matrix", () => {
  it("returns true when manifest is undefined and no override (#259)", () => {
    expect(_testOnly_shouldInjectDevtools(undefined, undefined)).toBe(true);
  });

  it("returns true for empty manifest — SSR-only landing (#259)", () => {
    expect(_testOnly_shouldInjectDevtools(undefined, emptyManifest())).toBe(true);
  });

  it("returns true when manifest has islands and no override", () => {
    expect(_testOnly_shouldInjectDevtools(undefined, manifestWithIsland())).toBe(true);
  });

  it("returns true when manifest has bundles even without islands map", () => {
    const m = emptyManifest();
    m.bundles["home"] = {
      js: "/.mandu/client/home.js",
      dependencies: [],
      priority: "visible",
    };
    expect(_testOnly_shouldInjectDevtools(undefined, m)).toBe(true);
  });

  it("devtools: true — forces inject (no-op vs new default but still honored)", () => {
    expect(_testOnly_shouldInjectDevtools(true, undefined)).toBe(true);
    expect(_testOnly_shouldInjectDevtools(true, emptyManifest())).toBe(true);
  });

  it("devtools: false — explicit opt-out skips even when islands exist", () => {
    expect(_testOnly_shouldInjectDevtools(false, manifestWithIsland())).toBe(false);
    expect(_testOnly_shouldInjectDevtools(false, emptyManifest())).toBe(false);
    expect(_testOnly_shouldInjectDevtools(false, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Streaming SSR mirror — must return identical answers to the ssr.ts path
// ---------------------------------------------------------------------------

describe("shouldInjectDevtoolsStreaming — parity with ssr.ts", () => {
  const cases: Array<[boolean | undefined, BundleManifest | undefined, string]> = [
    [undefined, undefined, "no manifest"],
    [undefined, emptyManifest(), "empty manifest"],
    [undefined, manifestWithIsland(), "manifest with island"],
    [true, undefined, "forced on"],
    [false, manifestWithIsland(), "forced off"],
  ];

  for (const [opt, mf, label] of cases) {
    it(`matches ssr.ts for ${label}`, () => {
      const a = _testOnly_shouldInjectDevtools(opt, mf);
      const b = _testOnly_shouldInjectDevtoolsStreaming(opt, mf);
      expect(a).toBe(b);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. URL shape + cache-bust
// ---------------------------------------------------------------------------

describe("generateDevtoolsScript — URL shape", () => {
  it("includes cache-bust `?v=<buildTime>` when manifest has buildTime", () => {
    const tag = _testOnly_generateDevtoolsScript(manifestWithIsland("home", "BUILD-123"));
    expect(tag).toContain("/.mandu/client/_devtools.js?v=");
    // buildTime is URL-encoded; our fixture value contains no reserved chars.
    expect(tag).toContain("BUILD-123");
  });

  it("URL-encodes ISO-format buildTime (contains `:`)", () => {
    const iso = "2026-04-19T12:00:00.000Z";
    const tag = _testOnly_generateDevtoolsScript(manifestWithIsland("home", iso));
    // encodeURIComponent turns `:` → `%3A`
    expect(tag).toContain("2026-04-19T12%3A00%3A00.000Z");
  });

  it("falls back to `?t=<timestamp>` when manifest is undefined", () => {
    const tag = _testOnly_generateDevtoolsScript(undefined);
    expect(tag).toMatch(/_devtools\.js\?t=\d+/);
  });

  it("Streaming variant produces equivalent URL shape", () => {
    const a = _testOnly_generateDevtoolsScript(manifestWithIsland("home", "STABLE"));
    const b = _testOnly_generateStreamingDevtoolsScript(manifestWithIsland("home", "STABLE"));
    // Both should contain the same `?v=STABLE` query segment
    expect(a).toContain("?v=STABLE");
    expect(b).toContain("?v=STABLE");
  });

  it("emits a module <script> tag (required for import.meta / ESM)", () => {
    const tag = _testOnly_generateDevtoolsScript(manifestWithIsland());
    expect(tag).toContain('<script type="module"');
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end through renderToHTML
// ---------------------------------------------------------------------------

describe("renderToHTML — #191 + #259 integration", () => {
  it("hasIslands:false + no override → devtools present (#259 default)", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: true,
    });
    expect(html).toContain("_devtools.js");
  });

  it("hasIslands:false + devtools:true → devtools present (forced inject)", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: true,
      devtools: true,
    });
    expect(html).toContain("_devtools.js");
  });

  it("hasIslands:false + devtools:false → devtools absent (opt-out)", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: true,
      devtools: false,
    });
    expect(html).not.toContain("_devtools.js");
  });

  it("hasIslands:true + no override → devtools present (default)", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: true,
      routeId: "home",
      hydration: { strategy: "island", priority: "visible", preload: false },
      bundleManifest: manifestWithIsland("home"),
    });
    expect(html).toContain("_devtools.js");
  });

  it("hasIslands:true + devtools:false → devtools absent (explicit opt-out)", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: true,
      devtools: false,
      routeId: "home",
      hydration: { strategy: "island", priority: "visible", preload: false },
      bundleManifest: manifestWithIsland("home"),
    });
    expect(html).not.toContain("_devtools.js");
  });

  it("prod mode (isDev:false) + devtools:true → devtools absent (prod no-op)", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: false,
      devtools: true,
      routeId: "home",
      hydration: { strategy: "island", priority: "visible", preload: false },
      bundleManifest: manifestWithIsland("home"),
    });
    expect(html).not.toContain("_devtools.js");
  });

  it("URL contains `?v=` cache-bust when manifest has buildTime", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: true,
      routeId: "home",
      hydration: { strategy: "island", priority: "visible", preload: false },
      bundleManifest: manifestWithIsland("home", "BUILD-XYZ"),
    });
    // Match the <script type="module" src="/.mandu/client/_devtools.js?v=..."></script> tag
    expect(html).toMatch(/_devtools\.js\?v=BUILD-XYZ/);
  });

  it("URL contains `?t=` fallback when devtools is forced on without manifest", () => {
    const html = renderToHTML(React.createElement("p", null, "hi"), {
      isDev: true,
      devtools: true,
      // No bundleManifest — falsetime fallback
    });
    expect(html).toMatch(/_devtools\.js\?t=\d+/);
  });
});

/**
 * Issue #193 — Regression tests for the opt-out SPA link handler.
 *
 * The contract under test lives in
 * `packages/core/src/client/router.ts` — `handleLinkClick`. The handler
 * should INTERCEPT (call `preventDefault`) for every plain internal
 * anchor click, and FALL THROUGH (leave `defaultPrevented` unchanged)
 * for every browser-owned scenario: external links, fragments,
 * `mailto:`, `target="_blank"`, `download`, modifier keys, non-left
 * clicks, and the explicit `data-no-spa` opt-out.
 *
 * We drive the handler with raw `MouseEvent`-shaped objects instead of
 * real DOM clicks — the function only reads well-typed properties, so
 * plain JS objects are enough and keep tests fast + deterministic.
 *
 * Global `__MANDU_SPA__` behavior is covered via the config-level
 * opt-out test at the end: setting the flag to `false` restores the
 * legacy opt-in behavior, where only `data-mandu-link` intercepts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _testOnly_handleLinkClick } from "../../src/client/router";

// -----------------------------------------------------------------
// Test harness: pluggable mock browser
// -----------------------------------------------------------------

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalHistory = globalThis.history;
const originalFetch = globalThis.fetch;

/**
 * `fetch` stub count — each interception would trigger an internal
 * `navigate(href)` call, which in turn calls `fetch`. We DON'T want
 * real network calls in unit tests, so we install a stub that records
 * whether navigation was attempted. The test assertion is on
 * `event.defaultPrevented` — a proxy for "the handler intercepted".
 */
let fetchCount = 0;

function installMockBrowser(opts: {
  /** Current document origin, e.g. `"http://localhost"`. */
  href: string;
  /** Simulated `window.__MANDU_SPA__` value. `undefined` = not set. */
  spaGlobal?: boolean;
}): void {
  const location = new URL(opts.href);
  fetchCount = 0;

  const windowObject: Record<string, unknown> = {
    location,
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {},
    __MANDU_DATA__: {},
    __MANDU_ROUTE__: undefined,
    __MANDU_ROUTER_STATE__: undefined,
    __MANDU_ROUTER_LISTENERS__: new Set(),
  };
  if (opts.spaGlobal !== undefined) {
    windowObject.__MANDU_SPA__ = opts.spaGlobal;
  }

  const historyObject = {
    pushState(_state: unknown, _title: string, url?: string | URL | null) {
      if (url) location.href = new URL(String(url), location.origin).href;
    },
    replaceState(_state: unknown, _title: string, url?: string | URL | null) {
      if (url) location.href = new URL(String(url), location.origin).href;
    },
  };
  windowObject.history = historyObject;

  (globalThis as Record<string, unknown>).window = windowObject;
  (globalThis as Record<string, unknown>).document = {};
  (globalThis as Record<string, unknown>).history = historyObject;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * Build a fake `<a>` node out of a simple attribute bag. `handleLinkClick`
 * only calls `getAttribute`, `hasAttribute`, and `closest` on anchors —
 * no layout or style access — so an object literal is a safe stand-in.
 */
function makeAnchor(attrs: Record<string, string | undefined>): HTMLElement {
  const store: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) store[k] = v;
  }
  return {
    getAttribute: (name: string): string | null =>
      Object.prototype.hasOwnProperty.call(store, name) ? store[name] : null,
    hasAttribute: (name: string): boolean =>
      Object.prototype.hasOwnProperty.call(store, name),
    closest: function (selector: string): HTMLElement | null {
      // Only the `"a"` selector is ever used by the handler — support
      // that single case by returning self.
      return selector === "a" ? this as unknown as HTMLElement : null;
    },
  } as unknown as HTMLElement;
}

/**
 * Build a fake `MouseEvent`-like object. The handler reads
 * `defaultPrevented`, `button`, `metaKey`, `altKey`, `ctrlKey`,
 * `shiftKey`, and `target`, and calls `preventDefault()`. Everything
 * else is irrelevant.
 */
function makeClick(opts: {
  anchor: HTMLElement;
  button?: number;
  metaKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}): MouseEvent {
  let prevented = !!opts.defaultPrevented;
  const event = {
    target: opts.anchor,
    button: opts.button ?? 0,
    metaKey: !!opts.metaKey,
    altKey: !!opts.altKey,
    ctrlKey: !!opts.ctrlKey,
    shiftKey: !!opts.shiftKey,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
  return event as unknown as MouseEvent;
}

afterEach(() => {
  (globalThis as Record<string, unknown>).window = originalWindow;
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).history = originalHistory;
  globalThis.fetch = originalFetch;
});

// -----------------------------------------------------------------
// New default: plain <a href> intercepts
// -----------------------------------------------------------------

describe("handleLinkClick — Issue #193 opt-out default", () => {
  beforeEach(() => {
    installMockBrowser({ href: "http://localhost/" });
  });

  it("intercepts a plain same-origin anchor without data-mandu-link (NEW DEFAULT)", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("intercepts an absolute same-origin anchor", () => {
    const anchor = makeAnchor({ href: "http://localhost/docs" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("intercepts when the anchor also has the legacy data-mandu-link attribute", () => {
    // Backward-compat: the legacy opt-in attribute still works; under
    // the new default it is simply a no-op (we already intercept).
    const anchor = makeAnchor({ href: "/legacy", "data-mandu-link": "" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("intercepts when href has a query string", () => {
    const anchor = makeAnchor({ href: "/search?q=mandu" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("intercepts when href has a trailing fragment but still navigates", () => {
    // `/about#team` still goes through the router — it's a cross-page
    // navigation with a fragment target, not a same-page anchor.
    const anchor = makeAnchor({ href: "/about#team" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

// -----------------------------------------------------------------
// Exclusions: must fall through to the browser
// -----------------------------------------------------------------

describe("handleLinkClick — exclusions fall through to the browser", () => {
  beforeEach(() => {
    installMockBrowser({ href: "http://localhost/" });
  });

  it("falls through when the anchor has no href attribute", () => {
    const anchor = makeAnchor({}); // no href
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for fragment-only same-page anchors", () => {
    const anchor = makeAnchor({ href: "#section-2" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for mailto: links", () => {
    const anchor = makeAnchor({ href: "mailto:hello@example.com" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for tel: links", () => {
    const anchor = makeAnchor({ href: "tel:+15551234567" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for javascript: pseudo-URLs", () => {
    const anchor = makeAnchor({ href: "javascript:void(0)" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for external (cross-origin) http links", () => {
    const anchor = makeAnchor({ href: "https://example.com/docs" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for target=_blank", () => {
    const anchor = makeAnchor({ href: "/about", target: "_blank" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for target=_top", () => {
    const anchor = makeAnchor({ href: "/about", target: "_top" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through for target=_parent", () => {
    const anchor = makeAnchor({ href: "/about", target: "_parent" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("INTERCEPTS for target=_self (explicit same-frame)", () => {
    const anchor = makeAnchor({ href: "/about", target: "_self" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("falls through when the download attribute is present", () => {
    const anchor = makeAnchor({ href: "/reports/report.pdf", download: "" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through on Ctrl+click (new-tab shortcut)", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor, ctrlKey: true });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through on Cmd+click (macOS new-tab shortcut)", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor, metaKey: true });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through on Shift+click (bookmark shortcut)", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor, shiftKey: true });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through on Alt+click (save-as shortcut)", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor, altKey: true });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through on middle-click (button=1, new-tab)", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor, button: 1 });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through on right-click (button=2, context menu)", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor, button: 2 });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through when a prior listener already called preventDefault", () => {
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor, defaultPrevented: true });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true); // unchanged (not re-prevented)
  });

  it("falls through when the click target has no ancestor anchor", () => {
    const event = {
      target: { closest: () => null } as unknown as HTMLElement,
      button: 0,
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault: () => {},
    } as unknown as MouseEvent;
    expect(() => _testOnly_handleLinkClick(event)).not.toThrow();
  });

  it("falls through when event.target is null", () => {
    const event = {
      target: null,
      button: 0,
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      defaultPrevented: false,
      preventDefault: () => {},
    } as unknown as MouseEvent;
    expect(() => _testOnly_handleLinkClick(event)).not.toThrow();
  });
});

// -----------------------------------------------------------------
// Per-link opt-out (data-no-spa)
// -----------------------------------------------------------------

describe("handleLinkClick — per-link data-no-spa opt-out", () => {
  beforeEach(() => {
    installMockBrowser({ href: "http://localhost/" });
  });

  it("falls through when data-no-spa is present", () => {
    const anchor = makeAnchor({ href: "/about", "data-no-spa": "" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("data-no-spa wins even when data-mandu-link is also present", () => {
    // If both are set, the explicit opt-out must take precedence to
    // give users a reliable escape hatch.
    const anchor = makeAnchor({
      href: "/about",
      "data-no-spa": "",
      "data-mandu-link": "",
    });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

// -----------------------------------------------------------------
// Global opt-out (window.__MANDU_SPA__ === false)
// -----------------------------------------------------------------

describe("handleLinkClick — global spa: false opt-out", () => {
  it("falls through for a plain anchor when window.__MANDU_SPA__ is false", () => {
    installMockBrowser({ href: "http://localhost/", spaGlobal: false });
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    // Plain anchors revert to legacy opt-in behavior under spa: false.
    expect(event.defaultPrevented).toBe(false);
  });

  it("still intercepts data-mandu-link anchors when spa: false (legacy opt-in)", () => {
    installMockBrowser({ href: "http://localhost/", spaGlobal: false });
    const anchor = makeAnchor({ href: "/about", "data-mandu-link": "" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("intercepts plain anchors when window.__MANDU_SPA__ is true (explicit on)", () => {
    installMockBrowser({ href: "http://localhost/", spaGlobal: true });
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("intercepts plain anchors when window.__MANDU_SPA__ is undefined (default on)", () => {
    installMockBrowser({ href: "http://localhost/" });
    const anchor = makeAnchor({ href: "/about" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("data-no-spa still wins under spa: false (redundant but safe)", () => {
    installMockBrowser({ href: "http://localhost/", spaGlobal: false });
    const anchor = makeAnchor({ href: "/about", "data-no-spa": "" });
    const event = makeClick({ anchor });
    _testOnly_handleLinkClick(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

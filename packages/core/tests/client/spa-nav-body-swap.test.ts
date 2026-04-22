/**
 * Issue #220 — SPA-nav helper body-swap observability + fallback tests.
 *
 * Complements `spa-nav-helper-exclusions.test.ts` (click exclusion
 * matrix) by exercising the *swap path* once navigation has been
 * committed:
 *   - happy path (<main>, #root, <body> container resolution + logging)
 *   - fetch failure → hardNav fallback + console.warn
 *   - non-HTML response → hardNav fallback
 *   - DOMParser parsererror → hardNav fallback
 *   - selector miss (no <main>/#root, no body) → hardNav fallback
 *   - script re-execution (inline + src)
 *   - View Transitions absent vs present (progressive enhancement)
 *   - __MANDU_SPA_NAV__ custom event dispatch with { url, durationMs }
 *   - large body chunk round-trip
 *
 * Driver strategy: we install a minimal DOM mock on globalThis,
 * evaluate `SPA_NAV_HELPER_BODY` with `new Function`, capture the
 * registered click listener, synthesize a click, and inspect the
 * resulting console/warn log + mock-body mutations.
 *
 * All assertions live inside this file — no JSDOM/happy-dom dependency
 * required (matches the pattern used by the sibling exclusion test).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SPA_NAV_HELPER_BODY } from "../../src/client/spa-nav-helper";

// ---------------------------------------------------------------------------
// Minimal DOM mock — just enough for the helper's swap path.
// We model <main>, #root, <body>, <head>, <title>, <script>, metas.
// ---------------------------------------------------------------------------

interface MockElement {
  tagName: string;
  id?: string;
  attributes: Array<{ name: string; value: string }>;
  children: MockElement[];
  parentNode: MockElement | null;
  innerHTML: string;
  textContent: string;
  outerHTML: string;
  src?: string;
  text?: string;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  querySelector: (sel: string) => MockElement | null;
  querySelectorAll: (sel: string) => MockElement[];
  getElementById?: (id: string) => MockElement | null;
  appendChild: (child: MockElement) => MockElement;
  removeChild: (child: MockElement) => MockElement;
  cloneNode: (deep?: boolean) => MockElement;
}

function makeEl(tagName: string, opts: { id?: string; innerHTML?: string; textContent?: string; src?: string; scriptChildren?: Array<{ src?: string; text?: string }> } = {}): MockElement {
  const children: MockElement[] = [];
  // Synthetic: allow tests to prepopulate <script> children so that
  // "setting .innerHTML then querySelectorAll('script')" finds them —
  // this mimics real DOM behavior that our tiny mock does not parse.
  if (opts.scriptChildren) {
    for (const s of opts.scriptChildren) {
      const sc = makeEl("script", { textContent: s.text ?? "", src: s.src });
      if (s.src) sc.setAttribute("src", s.src);
      children.push(sc);
    }
  }
  const el: MockElement = {
    tagName: tagName.toUpperCase(),
    id: opts.id,
    attributes: [],
    children,
    parentNode: null,
    innerHTML: opts.innerHTML ?? "",
    textContent: opts.textContent ?? "",
    outerHTML: `<${tagName.toLowerCase()}></${tagName.toLowerCase()}>`,
    src: opts.src,
    setAttribute(name, value) {
      this.attributes.push({ name, value });
      if (name === "src") this.src = value;
    },
    getAttribute(name) {
      const hit = this.attributes.find((a) => a.name === name);
      return hit ? hit.value : null;
    },
    hasAttribute(name) {
      return this.attributes.some((a) => a.name === name);
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      const out: MockElement[] = [];
      const walk = (n: MockElement): void => {
        if (matches(n, sel)) out.push(n);
        for (const c of n.children) walk(c);
      };
      for (const c of this.children) walk(c);
      return out;
    },
    getElementById(id) {
      const walk = (n: MockElement): MockElement | null => {
        if (n.id === id) return n;
        for (const c of n.children) {
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      for (const c of this.children) {
        const r = walk(c);
        if (r) return r;
      }
      return null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    cloneNode() {
      const clone = makeEl(tagName, { id: opts.id, innerHTML: opts.innerHTML, textContent: opts.textContent, src: opts.src });
      clone.attributes = [...this.attributes];
      clone.outerHTML = this.outerHTML;
      return clone;
    },
  };
  return el;
}

function matches(el: MockElement, sel: string): boolean {
  // Tiny selector matcher — supports tag, #id, tag[attr], tag[attr=value],
  // and comma-separated unions (meta[name=viewport],meta[charset] etc).
  const parts = sel.split(",").map((s) => s.trim());
  return parts.some((p) => matchesSingle(el, p));
}

function matchesSingle(el: MockElement, sel: string): boolean {
  // id
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  // tag[attr] or tag[attr=value]
  const m = sel.match(/^([a-z]+)(?:\[([a-z-]+)(?:=([^\]]+))?\])?$/i);
  if (!m) return false;
  const [, tag, attr, val] = m;
  if (el.tagName !== tag.toUpperCase()) return false;
  if (!attr) return true;
  const got = el.getAttribute(attr);
  if (got == null) return false;
  if (val == null) return true;
  const unquoted = val.replace(/^["']|["']$/g, "");
  return got === unquoted;
}

function makeDoc(opts: {
  mainInner?: string;
  rootInner?: string;
  bodyInner?: string;
  title?: string;
  scripts?: Array<{ src?: string; text?: string; async?: boolean }>;
  includeParseError?: boolean;
  noBody?: boolean;
}): MockElement {
  const doc = makeEl("document");
  const head = makeEl("head");
  head.parentNode = doc;
  doc.children.push(head);
  if (opts.title) {
    const t = makeEl("title", { textContent: opts.title });
    head.appendChild(t);
  }
  if (opts.includeParseError) {
    const pe = makeEl("parsererror", { textContent: "bad html" });
    doc.appendChild(pe);
  }
  if (!opts.noBody) {
    const body = makeEl("body", { innerHTML: opts.bodyInner ?? "" });
    doc.appendChild(body);
    if (opts.mainInner != null) {
      const main = makeEl("main", { innerHTML: opts.mainInner });
      body.appendChild(main);
    }
    if (opts.rootInner != null) {
      const root = makeEl("div", { id: "root", innerHTML: opts.rootInner });
      body.appendChild(root);
    }
    if (opts.scripts) {
      for (const s of opts.scripts) {
        const sc = makeEl("script", { textContent: s.text ?? "", src: s.src });
        if (s.src) sc.setAttribute("src", s.src);
        if (s.async) sc.setAttribute("async", "");
        body.appendChild(sc);
      }
    }
  }
  // Expose document-like fields used by the helper.
  (doc as unknown as Record<string, unknown>).head = head;
  (doc as unknown as Record<string, unknown>).body = doc.children.find((c) => c.tagName === "BODY") ?? null;
  return doc;
}

// ---------------------------------------------------------------------------
// Global install
// ---------------------------------------------------------------------------

type ClickListener = (ev: Record<string, unknown>) => void;

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalHistory = globalThis.history;
const originalFetch = globalThis.fetch;
const originalDOMParser = (globalThis as Record<string, unknown>).DOMParser;

let clickListeners: ClickListener[] = [];
let warnLog: Array<{ msg: string; detail: unknown }> = [];
let debugLog: Array<{ msg: string; detail: unknown }> = [];
let dispatchedEvents: Array<{ type: string; detail: unknown }> = [];
let hardNavTo: string | null = null;

interface MockInstallOpts {
  fetchImpl?: typeof fetch;
  docShape: Parameters<typeof makeDoc>[0];
  incomingHTML?: string;
  startViewTransition?: boolean;
  disableDOMParser?: boolean;
  parseThrows?: boolean;
}

function installMock(opts: MockInstallOpts): {
  mockDoc: Record<string, unknown>;
  mockMain: MockElement | null;
  mockRoot: MockElement | null;
  mockBody: MockElement;
  mockHead: MockElement;
} {
  clickListeners = [];
  warnLog = [];
  debugLog = [];
  dispatchedEvents = [];
  hardNavTo = null;

  // Plain object mimicking window.location — a Proxy around a real URL
  // trips the built-in URL getters ("this value is not a URL").
  const locState = { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "", hash: "", protocol: "http:" };
  const location = {
    get href() { return locState.href; },
    set href(v: string) { hardNavTo = v; },
    get origin() { return locState.origin; },
    get pathname() { return locState.pathname; },
    get search() { return locState.search; },
    get hash() { return locState.hash; },
    get protocol() { return locState.protocol; },
  };
  const currentBody = makeEl("body", { innerHTML: "<p>old</p>" });
  const currentHead = makeEl("head");
  const currentTitle = makeEl("title", { textContent: "old title" });
  currentHead.appendChild(currentTitle);

  const existingMain = opts.docShape.mainInner != null
    ? makeEl("main", { scriptChildren: opts.docShape.scripts })
    : null;
  if (existingMain) currentBody.appendChild(existingMain);
  const existingRoot = opts.docShape.rootInner != null ? makeEl("div", { id: "root" }) : null;
  if (existingRoot) currentBody.appendChild(existingRoot);

  const doc: Record<string, unknown> = {
    addEventListener: (type: string, listener: EventListener) => {
      if (type === "click") clickListeners.push(listener as unknown as ClickListener);
    },
    removeEventListener: () => {},
    documentElement: makeEl("html"),
    head: currentHead,
    body: currentBody,
    title: "old title",
    startViewTransition: opts.startViewTransition
      ? (cb: () => void): { finished: Promise<void> } => {
          cb();
          return { finished: Promise.resolve() };
        }
      : undefined,
    querySelector: (sel: string) => {
      if (sel === "main") return existingMain;
      if (sel === "title") return currentTitle;
      return null;
    },
    getElementById: (id: string) => {
      if (id === "root") return existingRoot;
      return null;
    },
    createElement: (tag: string) => {
      const el = makeEl(tag);
      // Stub: appending a <script> records the reload intent.
      return el;
    },
  };

  const win: Record<string, unknown> = {
    location,
    history: {
      pushState(_s: unknown, _t: string, url?: string | null) {
        if (url) locState.pathname = String(url);
      },
      replaceState() {},
    },
    scrollTo: () => {},
    addEventListener: () => {},
    dispatchEvent: (ev: { type: string; detail?: unknown }) => {
      dispatchedEvents.push({ type: ev.type, detail: ev.detail });
      return true;
    },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
  };

  if (opts.disableDOMParser) {
    (globalThis as Record<string, unknown>).DOMParser = undefined;
  } else {
    class MockDOMParser {
      parseFromString(): MockElement {
        if (opts.parseThrows) throw new Error("parser boom");
        const parsed = makeDoc(opts.docShape);
        return parsed;
      }
    }
    (globalThis as Record<string, unknown>).DOMParser = MockDOMParser;
  }

  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).history = win.history;
  globalThis.fetch =
    opts.fetchImpl ??
    ((async () =>
      new Response(opts.incomingHTML ?? "<html><body><p>new</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch);

  // Hook console.warn / console.debug.
  const origWarn = console.warn;
  const origDebug = console.debug;
  console.warn = (msg: string, detail?: unknown) => {
    warnLog.push({ msg: String(msg), detail });
  };
  console.debug = (msg: string, detail?: unknown) => {
    debugLog.push({ msg: String(msg), detail });
  };
  // Restore on teardown.
  (globalThis as Record<string, unknown>).__origWarn = origWarn;
  (globalThis as Record<string, unknown>).__origDebug = origDebug;

  return {
    mockDoc: doc,
    mockMain: existingMain,
    mockRoot: existingRoot,
    mockBody: currentBody,
    mockHead: currentHead,
  };
}

function runHelper(): void {
  new Function(SPA_NAV_HELPER_BODY)();
}

function makeAnchor(href: string): unknown {
  return {
    getAttribute(name: string): string | null {
      return name === "href" ? href : null;
    },
    hasAttribute(): boolean {
      return false;
    },
    closest(sel: string): unknown {
      return sel === "a" ? this : null;
    },
  };
}

function makeClick(anchor: unknown): Record<string, unknown> {
  let prevented = false;
  return {
    target: anchor,
    button: 0,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}

async function dispatchAndWait(anchor: unknown): Promise<void> {
  const ev = makeClick(anchor);
  for (const l of clickListeners) l(ev);
  // let fetch + promise microtasks settle
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => {
  (globalThis as Record<string, unknown>).window = originalWindow;
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).history = originalHistory;
  globalThis.fetch = originalFetch;
  (globalThis as Record<string, unknown>).DOMParser = originalDOMParser;
  const w = (globalThis as Record<string, unknown>).__origWarn as typeof console.warn | undefined;
  const d = (globalThis as Record<string, unknown>).__origDebug as typeof console.debug | undefined;
  if (w) console.warn = w;
  if (d) console.debug = d;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SPA_NAV_HELPER — body swap happy paths", () => {
  it("1. swaps into <main> when incoming document has <main>", async () => {
    const mocks = installMock({
      docShape: { mainInner: "<h1>hello</h1>", title: "new" },
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/about"));
    expect(mocks.mockMain?.innerHTML).toBe("<h1>hello</h1>");
    expect(hardNavTo).toBeNull();
    expect(debugLog.some((e) => e.msg.includes("container: main"))).toBe(true);
  });

  it("2. swaps into #root when no <main> but #root present", async () => {
    const mocks = installMock({
      docShape: { rootInner: "<div>rooted</div>", title: "rooted" },
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/about"));
    expect(mocks.mockRoot?.innerHTML).toBe("<div>rooted</div>");
    expect(hardNavTo).toBeNull();
    expect(debugLog.some((e) => e.msg.includes("container: #root"))).toBe(true);
  });

  it("3. swaps into <body> when no <main>/#root", async () => {
    const mocks = installMock({
      docShape: { bodyInner: "<span>bare</span>", title: "bare" },
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/about"));
    // After assignment, current body innerHTML reflects the new body's innerHTML.
    expect(mocks.mockBody.innerHTML).toBe("<span>bare</span>");
    expect(debugLog.some((e) => e.msg.includes("container: body"))).toBe(true);
    expect(hardNavTo).toBeNull();
  });

  it("4. logs a success message with duration in ms", async () => {
    installMock({ docShape: { mainInner: "<p>ok</p>", title: "t" } });
    runHelper();
    await dispatchAndWait(makeAnchor("/x"));
    const msg = debugLog.find((e) => e.msg.includes("swapped to /x"));
    expect(msg).toBeDefined();
    expect(/in \d+ms/.test(msg!.msg)).toBe(true);
  });
});

describe("SPA_NAV_HELPER — failure paths fall back to full nav", () => {
  it("5. fetch non-ok (500) → hardNav + warn", async () => {
    installMock({
      docShape: { mainInner: "<p>x</p>" },
      fetchImpl: (async () =>
        new Response("boom", { status: 500, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/err"));
    expect(hardNavTo).toBe("/err");
    expect(warnLog.some((w) => w.msg.includes("fetch responded 500"))).toBe(true);
  });

  it("6. non-HTML content-type → hardNav + warn", async () => {
    installMock({
      docShape: { mainInner: "<p>x</p>" },
      fetchImpl: (async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/j"));
    expect(hardNavTo).toBe("/j");
    expect(warnLog.some((w) => w.msg.includes("non-HTML response"))).toBe(true);
  });

  it("7. DOMParser unavailable → hardNav + warn", async () => {
    installMock({
      docShape: { mainInner: "<p>x</p>" },
      disableDOMParser: true,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/p"));
    expect(hardNavTo).toBe("/p");
    expect(warnLog.some((w) => w.msg.includes("DOMParser unavailable"))).toBe(true);
  });

  it("8. DOMParser throws → hardNav + warn", async () => {
    installMock({
      docShape: { mainInner: "<p>x</p>" },
      parseThrows: true,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/t"));
    expect(hardNavTo).toBe("/t");
    expect(warnLog.some((w) => w.msg.includes("DOMParser threw"))).toBe(true);
  });

  it("9. parsererror node in output → hardNav + warn", async () => {
    installMock({
      docShape: { mainInner: "<p>x</p>", includeParseError: true },
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/pe"));
    expect(hardNavTo).toBe("/pe");
    expect(warnLog.some((w) => w.msg.includes("parsererror"))).toBe(true);
  });

  it("10. no swap container matched → hardNav + warn", async () => {
    installMock({
      docShape: { noBody: true },
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/empty"));
    expect(hardNavTo).toBe("/empty");
    expect(warnLog.some((w) => w.msg.includes("no swap container matched"))).toBe(true);
    // human-readable explanation should not use literal `<body>` which
    // would confuse SSR html-splitting tests.
    expect(warnLog.some((w) => w.msg.includes("<body>"))).toBe(false);
  });

  it("11. fetch rejects → hardNav + warn", async () => {
    installMock({
      docShape: { mainInner: "<p>x</p>" },
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/off"));
    expect(hardNavTo).toBe("/off");
    expect(warnLog.some((w) => w.msg.includes("fetch rejected"))).toBe(true);
  });
});

describe("SPA_NAV_HELPER — script re-execution", () => {
  it("12. inline <script> tags are re-created and appended to head", async () => {
    const appended: MockElement[] = [];
    const mocks = installMock({
      docShape: {
        mainInner: "",
        scripts: [{ text: "window.__spa_script_ran__ = 42;" }],
        title: "s",
      },
    });
    // Patch document.head.appendChild to observe script reinsertion.
    const origAppend = mocks.mockHead.appendChild.bind(mocks.mockHead);
    mocks.mockHead.appendChild = (child: MockElement) => {
      appended.push(child);
      return origAppend(child);
    };
    runHelper();
    await dispatchAndWait(makeAnchor("/s"));
    const scriptAppended = appended.find((e) => e.tagName === "SCRIPT");
    expect(scriptAppended).toBeDefined();
    expect(scriptAppended?.text ?? "").toContain("__spa_script_ran__");
  });

  it("13. <script src> retains src attribute on re-creation", async () => {
    const appended: MockElement[] = [];
    const mocks = installMock({
      docShape: {
        mainInner: "",
        scripts: [{ src: "/hydrate.js" }],
        title: "s",
      },
    });
    const origAppend = mocks.mockHead.appendChild.bind(mocks.mockHead);
    mocks.mockHead.appendChild = (child: MockElement) => {
      appended.push(child);
      return origAppend(child);
    };
    runHelper();
    await dispatchAndWait(makeAnchor("/s2"));
    const scriptAppended = appended.find((e) => e.tagName === "SCRIPT");
    expect(scriptAppended).toBeDefined();
    expect(scriptAppended?.getAttribute("src")).toBe("/hydrate.js");
  });
});

describe("SPA_NAV_HELPER — View Transitions integration", () => {
  it("14. runs swap directly when startViewTransition is absent", async () => {
    const mocks = installMock({
      docShape: { mainInner: "<p>noVT</p>", title: "n" },
      startViewTransition: false,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/nvt"));
    expect(mocks.mockMain?.innerHTML).toBe("<p>noVT</p>");
    expect(hardNavTo).toBeNull();
  });

  it("15. uses startViewTransition when available", async () => {
    const mocks = installMock({
      docShape: { mainInner: "<p>VT</p>", title: "n" },
      startViewTransition: true,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/vt"));
    expect(mocks.mockMain?.innerHTML).toBe("<p>VT</p>");
  });
});

describe("SPA_NAV_HELPER — hydration event dispatch", () => {
  it("16. dispatches __MANDU_SPA_NAV__ with { url, durationMs, container }", async () => {
    installMock({ docShape: { mainInner: "<p>hi</p>", title: "t" } });
    runHelper();
    await dispatchAndWait(makeAnchor("/evt"));
    const fired = dispatchedEvents.find((e) => e.type === "__MANDU_SPA_NAV__");
    expect(fired).toBeDefined();
    const detail = fired?.detail as { url: string; durationMs: number; container: string } | undefined;
    expect(detail?.url).toBe("/evt");
    expect(detail?.container).toBe("main");
    expect(typeof detail?.durationMs).toBe("number");
  });

  it("17. does not dispatch __MANDU_SPA_NAV__ on fallback path", async () => {
    installMock({
      docShape: { mainInner: "<p>x</p>" },
      fetchImpl: (async () =>
        new Response("e", { status: 500, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/nope"));
    expect(dispatchedEvents.some((e) => e.type === "__MANDU_SPA_NAV__")).toBe(false);
    expect(hardNavTo).toBe("/nope");
  });
});

describe("SPA_NAV_HELPER — large body chunk", () => {
  it("18. swaps a large (~100 KB) body without truncating", async () => {
    const big = "<p>" + "x".repeat(100_000) + "</p>";
    const mocks = installMock({
      docShape: { mainInner: big, title: "big" },
    });
    runHelper();
    await dispatchAndWait(makeAnchor("/big"));
    expect(mocks.mockMain?.innerHTML.length).toBe(big.length);
    expect(hardNavTo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #233 — cross-layout transitions must fall back to hardNav.
//
// Before the fix: `<main>.innerHTML` swap left the SOURCE layout chrome
// (e.g. docs `<aside>` sidebar) intact while replacing body content with
// the DESTINATION layout's main content — DOM logically broken until
// F5.
//
// After the fix: the SSR shell stamps `data-mandu-layout="<hash>"` on
// `<div id="root">`. The helper compares the current DOM's key against
// the parsed destination key; if they differ, soft swap is aborted and
// `location.href = url` runs a full page load. Same-layout transitions
// (e.g. `/posts/a` → `/posts/b`) keep the cheap soft swap.
//
// Regression guard — the critical literal `data-mandu-layout` must
// appear in the minified helper body, and the helper source must
// reference the transition-rejection reason. If this test fails the
// cross-layout detection was lost.
// ---------------------------------------------------------------------------
describe("SPA_NAV_HELPER — #233 cross-layout detection", () => {
  it("19. helper source references data-mandu-layout attribute", () => {
    expect(SPA_NAV_HELPER_BODY).toContain("data-mandu-layout");
  });

  it("20. helper emits a distinct hardNav reason on cross-layout transitions", () => {
    expect(SPA_NAV_HELPER_BODY).toContain("cross-layout transition");
  });

  it("21. helper compares current vs destination #root layout key in doSwap", () => {
    // Cheap structural check: the transition-rejection block runs inside
    // doSwap, before pickContainer, and the literals below cover the
    // three operations that must stay wired up.
    expect(SPA_NAV_HELPER_BODY).toMatch(/getElementById\("root"\)/);
    expect(SPA_NAV_HELPER_BODY).toMatch(/getAttribute\("data-mandu-layout"\)/);
    expect(SPA_NAV_HELPER_BODY).toMatch(/ck&&nk&&ck!==nk/);
  });
});

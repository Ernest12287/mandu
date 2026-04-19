/**
 * Issue #198 — Async Server Component regression tests.
 *
 * Ensures `export default async function Page() {...}` and
 * `export default async function Layout({children}) {...}` render
 * correctly through both the sync (`renderToHTML` / `renderSSR`) and
 * pre-resolution (`resolveAsyncElement`) paths, without throwing or
 * emitting `[object Promise]` in the HTML body.
 *
 * Covers:
 *   1. Top-level async page component → resolved + rendered
 *   2. Nested sync layout wrapping async page
 *   3. Async layout wrapping sync page
 *   4. Async layout wrapping async page (both levels)
 *   5. Async component with children passthrough
 *   6. Async component that throws → error propagates
 *   7. Arrays / fragments of async components
 *   8. Mixed sync + async siblings
 *   9. Deep nested async (3 levels)
 *   10. Non-element inputs pass through unchanged
 *   11. Sync components preserve hooks / context (not pre-invoked)
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { renderToHTML, renderSSR, resolveAsyncElement } from "../../src/runtime/ssr";
import { renderStreamingResponse } from "../../src/runtime/streaming-ssr";

// ---------------------------------------------------------------------------
// Helpers — async component factories
// ---------------------------------------------------------------------------

function makeAsyncPage(text: string): () => Promise<React.ReactElement> {
  return async function AsyncPage() {
    // Simulate a server-side fetch. Zero-delay microtask is enough to
    // prove the component is truly async (constructor.name === "AsyncFunction").
    const data = await Promise.resolve({ title: text });
    return React.createElement("h1", { className: "async-page" }, data.title);
  };
}

function makeAsyncLayout(
  wrapperClass: string
): (props: { children?: React.ReactNode }) => Promise<React.ReactElement> {
  return async function AsyncLayout({ children }) {
    await Promise.resolve();
    return React.createElement(
      "div",
      { className: wrapperClass },
      children ?? null
    );
  };
}

// ---------------------------------------------------------------------------
// resolveAsyncElement — direct unit tests
// ---------------------------------------------------------------------------

describe("resolveAsyncElement — primitives & non-elements", () => {
  it("passes through null", async () => {
    expect(await resolveAsyncElement(null)).toBeNull();
  });

  it("passes through undefined", async () => {
    expect(await resolveAsyncElement(undefined)).toBeUndefined();
  });

  it("passes through strings", async () => {
    expect(await resolveAsyncElement("plain text")).toBe("plain text");
  });

  it("passes through numbers", async () => {
    expect(await resolveAsyncElement(42)).toBe(42);
  });

  it("passes through booleans", async () => {
    expect(await resolveAsyncElement(true)).toBe(true);
    expect(await resolveAsyncElement(false)).toBe(false);
  });

  it("passes through plain non-React objects unchanged", async () => {
    const obj = { foo: "bar" } as unknown as React.ReactNode;
    const out = await resolveAsyncElement(obj);
    // Cast both sides to `unknown` — React 19's `ReactNode` includes
    // `Promise<AwaitedReactNode>` which makes `toBe` reject the direct
    // form. Reference identity is all we're asserting.
    expect(out as unknown).toBe(obj as unknown);
  });
});

describe("resolveAsyncElement — sync elements", () => {
  it("returns a sync intrinsic element unchanged (reference equality)", async () => {
    const el = React.createElement("div", null, "hello");
    const resolved = await resolveAsyncElement(el);
    // Sync element with no async descendants → returned as-is.
    expect(resolved).toBe(el);
  });

  it("leaves sync function components alone (does not pre-invoke)", async () => {
    let invocationCount = 0;
    function SyncComp() {
      invocationCount++;
      return React.createElement("span", null, "sync");
    }
    const el = React.createElement(SyncComp);
    const resolved = await resolveAsyncElement(el);

    // Sync function component must NOT be invoked by the resolver —
    // React handles it during renderToString. If we pre-invoked, hooks
    // and context would break.
    expect(invocationCount).toBe(0);
    expect(resolved).toBe(el);
  });
});

describe("resolveAsyncElement — async components", () => {
  it("invokes a top-level async component and returns its resolved tree", async () => {
    const AsyncPage = makeAsyncPage("Hello Async");
    const el = React.createElement(AsyncPage);
    const resolved = await resolveAsyncElement(el);

    // Resolved element is the <h1> returned by AsyncPage — no longer wraps
    // the async function component.
    expect(React.isValidElement(resolved)).toBe(true);
    expect((resolved as React.ReactElement).type).toBe("h1");
  });

  it("propagates props to the async component", async () => {
    const Captured: Record<string, unknown> = {};
    async function AsyncWithProps(props: { name: string; count: number }) {
      Captured.name = props.name;
      Captured.count = props.count;
      return React.createElement("p", null, `${props.name}:${props.count}`);
    }
    const el = React.createElement(AsyncWithProps, { name: "x", count: 7 });
    await resolveAsyncElement(el);
    expect(Captured.name).toBe("x");
    expect(Captured.count).toBe(7);
  });

  it("passes an empty object when async component has no props", async () => {
    async function NoProps(p: Record<string, unknown>) {
      // Must receive a non-null object (React contract).
      expect(p).toBeDefined();
      return React.createElement("i", null, "ok");
    }
    const el = React.createElement(NoProps);
    const resolved = await resolveAsyncElement(el);
    expect((resolved as React.ReactElement).type).toBe("i");
  });

  it("recursively resolves nested async components (async layout → async page)", async () => {
    const AsyncLayout = makeAsyncLayout("outer");
    const AsyncPage = makeAsyncPage("Inner Content");
    const tree = React.createElement(
      AsyncLayout,
      null,
      React.createElement(AsyncPage)
    );
    const resolved = await resolveAsyncElement(tree);

    // Outer <div class="outer"> with inner <h1 class="async-page">
    expect(React.isValidElement(resolved)).toBe(true);
    const outer = resolved as React.ReactElement;
    expect(outer.type).toBe("div");
    const innerChildren = (outer.props as { children: React.ReactElement })
      .children;
    expect(React.isValidElement(innerChildren)).toBe(true);
    expect(innerChildren.type).toBe("h1");
  });

  it("resolves 3-level deep async nesting", async () => {
    const L1 = makeAsyncLayout("l1");
    const L2 = makeAsyncLayout("l2");
    const L3 = makeAsyncLayout("l3");
    const Page = makeAsyncPage("deep");

    const tree = React.createElement(
      L1,
      null,
      React.createElement(
        L2,
        null,
        React.createElement(L3, null, React.createElement(Page))
      )
    );
    const resolved = await resolveAsyncElement(tree);
    const html = renderToHTML(resolved as React.ReactElement, { title: "x" });
    expect(html).toContain('class="l1"');
    expect(html).toContain('class="l2"');
    expect(html).toContain('class="l3"');
    expect(html).toContain('class="async-page"');
    expect(html).toContain("deep");
  });

  it("propagates rejection when async component throws", async () => {
    async function Broken(): Promise<React.ReactNode> {
      throw new Error("boom from async");
    }
    const el = React.createElement(Broken);
    await expect(resolveAsyncElement(el)).rejects.toThrow("boom from async");
  });
});

describe("resolveAsyncElement — children & arrays", () => {
  it("resolves async component nested inside a sync element", async () => {
    const AsyncPage = makeAsyncPage("Inside Sync");
    const tree = React.createElement(
      "main",
      null,
      React.createElement(AsyncPage)
    );
    const resolved = await resolveAsyncElement(tree);

    const main = resolved as React.ReactElement;
    expect(main.type).toBe("main");
    const inner = (main.props as { children: React.ReactElement }).children;
    expect(inner.type).toBe("h1");
  });

  it("resolves arrays of mixed sync and async siblings", async () => {
    const AsyncA = makeAsyncPage("A");
    const AsyncB = makeAsyncPage("B");
    const tree = React.createElement(
      "section",
      null,
      React.createElement("span", { key: "s" }, "sync-sibling"),
      React.createElement(AsyncA, { key: "a" }),
      React.createElement(AsyncB, { key: "b" })
    );
    const resolved = await resolveAsyncElement(tree);
    const html = renderToHTML(resolved as React.ReactElement, { title: "x" });

    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
    expect(html).toContain("sync-sibling");
    expect(html).not.toContain("[object Promise]");
  });

  it("resolves async components inside React.Fragment", async () => {
    const AsyncA = makeAsyncPage("fragA");
    const AsyncB = makeAsyncPage("fragB");
    const frag = React.createElement(
      React.Fragment,
      null,
      React.createElement(AsyncA, { key: "a" }),
      React.createElement(AsyncB, { key: "b" })
    );
    const resolved = await resolveAsyncElement(frag);
    const html = renderToHTML(
      React.createElement("div", null, resolved as React.ReactElement),
      { title: "x" }
    );
    expect(html).toContain("fragA");
    expect(html).toContain("fragB");
    expect(html).not.toContain("[object Promise]");
  });
});

// ---------------------------------------------------------------------------
// End-to-end via renderSSR / renderToHTML
// ---------------------------------------------------------------------------

describe("renderSSR — async server components (issue #198)", () => {
  it("renders an async page component to HTML after pre-resolution", async () => {
    const AsyncPage = makeAsyncPage("From Async Page");
    const rawEl = React.createElement(AsyncPage);
    const resolved = (await resolveAsyncElement(rawEl)) as React.ReactElement;

    const response = renderSSR(resolved, { title: "Async Test" });
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Async Test</title>");
    expect(html).toContain('<h1 class="async-page">From Async Page</h1>');
    expect(html).not.toContain("[object Promise]");
  });

  it("renders async layout wrapping sync page", async () => {
    const AsyncLayout = makeAsyncLayout("app-shell");
    function SyncPage() {
      return React.createElement("p", null, "sync page body");
    }

    const tree = React.createElement(
      AsyncLayout,
      null,
      React.createElement(SyncPage)
    );
    const resolved = (await resolveAsyncElement(tree)) as React.ReactElement;
    const response = renderSSR(resolved, { title: "Layout Test" });
    const html = await response.text();

    expect(html).toContain('class="app-shell"');
    expect(html).toContain("sync page body");
    expect(html).not.toContain("[object Promise]");
  });

  it("renders async layout wrapping async page (both async)", async () => {
    const AsyncLayout = makeAsyncLayout("both-layout");
    const AsyncPage = makeAsyncPage("both-page");
    const tree = React.createElement(
      AsyncLayout,
      null,
      React.createElement(AsyncPage)
    );
    const resolved = (await resolveAsyncElement(tree)) as React.ReactElement;
    const response = renderSSR(resolved, { title: "Both Async" });
    const html = await response.text();

    expect(html).toContain('class="both-layout"');
    expect(html).toContain('class="async-page"');
    expect(html).toContain("both-page");
    expect(html).not.toContain("[object Promise]");
  });

  it("renders renderToHTML directly when tree is pre-resolved (no Promise leakage)", async () => {
    const AsyncPage = makeAsyncPage("direct");
    const rawEl = React.createElement(AsyncPage);
    const resolved = (await resolveAsyncElement(rawEl)) as React.ReactElement;
    const html = renderToHTML(resolved, { title: "Direct" });

    expect(html).toContain(">direct<");
    expect(html).not.toContain("[object Promise]");
  });
});

// ---------------------------------------------------------------------------
// generateMetadata — verify async metadata pipeline (already working)
// ---------------------------------------------------------------------------

describe("renderSSR — async component does not interfere with title option", () => {
  it("preserves SSROptions.title even when element is async-resolved", async () => {
    const AsyncPage = makeAsyncPage("ignored-inner-text");
    const resolved = (await resolveAsyncElement(
      React.createElement(AsyncPage)
    )) as React.ReactElement;
    const response = renderSSR(resolved, { title: "Outer Title" });
    const html = await response.text();

    // Title comes from SSROptions, not the async component body.
    expect(html).toContain("<title>Outer Title</title>");
    expect(html).toContain("ignored-inner-text");
  });
});

// ---------------------------------------------------------------------------
// Streaming SSR — async server components via React's native support
// ---------------------------------------------------------------------------

describe("Streaming SSR — async components (issue #198)", () => {
  it("streams HTML with pre-resolved async component", async () => {
    const AsyncPage = makeAsyncPage("stream-async");
    const rawEl = React.createElement(AsyncPage);
    // Pre-resolve: same path `server.ts` uses.
    const resolved = (await resolveAsyncElement(rawEl)) as React.ReactElement;

    const response = await renderStreamingResponse(resolved, {
      title: "Streaming Async",
      routeId: "async-stream",
    });
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("stream-async");
    expect(html).not.toContain("[object Promise]");
  });

  it("streams HTML with pre-resolved async layout + async page", async () => {
    const AsyncLayout = makeAsyncLayout("stream-layout");
    const AsyncPage = makeAsyncPage("stream-body");
    const tree = React.createElement(
      AsyncLayout,
      null,
      React.createElement(AsyncPage)
    );
    const resolved = (await resolveAsyncElement(tree)) as React.ReactElement;

    const response = await renderStreamingResponse(resolved, {
      title: "Streaming Nested",
      routeId: "async-nested-stream",
    });
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('class="stream-layout"');
    expect(html).toContain("stream-body");
    expect(html).not.toContain("[object Promise]");
  });
});

// ---------------------------------------------------------------------------
// Generative check — confirm constructor.name detection is correct
// ---------------------------------------------------------------------------

describe("resolveAsyncElement — AsyncFunction detection", () => {
  it("detects arrow-function async components", async () => {
    const Arrow = async () =>
      React.createElement("em", null, "arrow-async");
    const el = React.createElement(Arrow);
    const resolved = await resolveAsyncElement(el);
    expect((resolved as React.ReactElement).type).toBe("em");
  });

  it("detects named async function declarations", async () => {
    async function Named() {
      return React.createElement("strong", null, "named-async");
    }
    const el = React.createElement(Named);
    const resolved = await resolveAsyncElement(el);
    expect((resolved as React.ReactElement).type).toBe("strong");
  });

  it("does NOT invoke a sync function that returns a Promise (constructor !== AsyncFunction)", async () => {
    // A regular function that returns a Promise is NOT an AsyncFunction.
    // We deliberately skip it — React would handle a Promise child via
    // Suspense semantics if needed. Pre-invoking here would be incorrect.
    function PromiseReturning() {
      return Promise.resolve(React.createElement("b", null, "promise"));
    }
    const el = React.createElement(
      PromiseReturning as unknown as React.FC
    );
    const resolved = await resolveAsyncElement(el);
    // The element is returned unchanged (sync function path).
    expect(resolved).toBe(el);
  });
});

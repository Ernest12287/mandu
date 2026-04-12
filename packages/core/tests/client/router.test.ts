import { afterEach, describe, expect, it } from "bun:test";
import {
  getActionData,
  getRouterState,
  navigate,
  setShouldRevalidate,
  submitAction,
} from "../../src/client/router";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalHistory = globalThis.history;
const originalFetch = globalThis.fetch;

function installMockBrowser(initialHref: string) {
  const location = new URL(initialHref);
  const windowObject: any = {
    location,
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {},
    __MANDU_DATA__: {},
    __MANDU_ROUTE__: {
      id: "posts",
      pattern: "/posts/:id",
      params: { id: "1" },
    },
    __MANDU_ROUTER_STATE__: {
      currentRoute: {
        id: "posts",
        pattern: "/posts/:id",
        params: { id: "1" },
      },
      loaderData: { items: ["before"] },
      actionData: { stale: true },
      navigation: { state: "idle" },
    },
    __MANDU_ROUTER_LISTENERS__: new Set(),
  };

  const historyObject = {
    pushState(_state: unknown, _title: string, url?: string | URL | null) {
      if (url) {
        location.href = new URL(String(url), location.origin).href;
      }
    },
    replaceState(_state: unknown, _title: string, url?: string | URL | null) {
      if (url) {
        location.href = new URL(String(url), location.origin).href;
      }
    },
  };

  windowObject.history = historyObject;
  (globalThis as any).window = windowObject;
  (globalThis as any).document = {};
  (globalThis as any).history = historyObject;
}

afterEach(() => {
  setShouldRevalidate(null);
  (globalThis as any).window = originalWindow;
  (globalThis as any).document = originalDocument;
  (globalThis as any).history = originalHistory;
  globalThis.fetch = originalFetch;
});

describe("client router", () => {
  it("keeps loader data but updates route state when shouldRevalidate returns false", async () => {
    installMockBrowser("http://localhost/posts/1");
    let fetchCalled = false;
    globalThis.fetch = ((async () => {
      fetchCalled = true;
      return Response.json({});
    }) as unknown) as typeof fetch;

    setShouldRevalidate(() => false);
    await navigate("/posts/2?tab=summary", { scroll: false });

    expect(fetchCalled).toBe(false);
    expect(getRouterState().currentRoute).toEqual({
      id: "posts",
      pattern: "/posts/:id",
      params: { id: "2" },
    });
    expect(getRouterState().loaderData).toEqual({ items: ["before"] });
    expect(getRouterState().actionData).toBeUndefined();
    expect(globalThis.window.location.href).toBe("http://localhost/posts/2?tab=summary");
  });

  it("stores the action payload instead of the transport envelope", async () => {
    installMockBrowser("http://localhost/posts/1");
    globalThis.fetch = ((async () =>
      Response.json({
        _revalidated: true,
        actionData: { created: true },
        loaderData: { items: ["after"] },
      })) as unknown) as typeof fetch;

    const result = await submitAction("http://localhost/api/posts", { title: "hello" }, "create");

    expect(result.ok).toBe(true);
    expect(result.actionData).toEqual({ created: true });
    expect(getActionData<{ created: boolean }>()).toEqual({ created: true });
    expect(getRouterState().loaderData).toEqual({ items: ["after"] });
  });
});

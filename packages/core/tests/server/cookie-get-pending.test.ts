/**
 * `ctx.cookies.get()` must reflect values written earlier in the same request
 * so middleware pipelines can relay cookies (e.g. session middleware sets a
 * fresh cookie, then downstream code reads it).
 *
 * Regression guard for DX-4.
 */

import { describe, it, expect } from "bun:test";
import { CookieManager } from "../../src/filling/context";

function req(cookieHeader?: string): Request {
  return new Request("https://test.local/", {
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
}

describe("CookieManager.get — pending response cookies", () => {
  it("returns the value written in the same request before any response", () => {
    const cookies = new CookieManager(req());
    cookies.set("token", "abc123");
    expect(cookies.get("token")).toBe("abc123");
  });

  it("pending response value overrides request value", () => {
    const cookies = new CookieManager(req("token=old-value"));
    cookies.set("token", "new-value");
    expect(cookies.get("token")).toBe("new-value");
  });

  it("delete hides the request value from subsequent get()", () => {
    const cookies = new CookieManager(req("token=old-value"));
    cookies.delete("token");
    expect(cookies.get("token")).toBeUndefined();
  });

  it("set after delete makes the new value visible again", () => {
    const cookies = new CookieManager(req("token=old-value"));
    cookies.delete("token");
    cookies.set("token", "reinstated");
    expect(cookies.get("token")).toBe("reinstated");
  });

  it("has() reflects pending writes", () => {
    const cookies = new CookieManager(req());
    expect(cookies.has("new")).toBe(false);
    cookies.set("new", "v");
    expect(cookies.has("new")).toBe(true);
  });

  it("has() returns false after delete on a request cookie", () => {
    const cookies = new CookieManager(req("stale=yes"));
    expect(cookies.has("stale")).toBe(true);
    cookies.delete("stale");
    expect(cookies.has("stale")).toBe(false);
  });

  it("getAll() merges request + pending, response overriding", () => {
    const cookies = new CookieManager(req("a=1; b=2"));
    cookies.set("b", "2-updated");
    cookies.set("c", "3-new");
    cookies.delete("a");
    expect(cookies.getAll()).toEqual({ b: "2-updated", c: "3-new" });
  });

  it("does not leak pending state across CookieManager instances", () => {
    const first = new CookieManager(req());
    first.set("scoped", "one");
    const second = new CookieManager(req());
    expect(second.get("scoped")).toBeUndefined();
  });
});

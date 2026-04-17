/**
 * Unit tests for the module-level HTTP error helpers (Phase 6.3).
 *
 * Companion to the ctx.unauthorized() / ctx.forbidden() / ctx.error()
 * methods on ManduContext — those live in filling/context.ts. These
 * standalone helpers must match ctx behavior for body shape while also
 * covering the header-merging contract (WWW-Authenticate, custom headers).
 */

import { describe, it, expect } from "bun:test";
import { unauthorized, forbidden, badRequest } from "../http-errors";

async function readJson(res: Response): Promise<unknown> {
  const clone = res.clone();
  const text = await clone.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

describe("unauthorized()", () => {
  it("returns 401 with the default WWW-Authenticate: Bearer header", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await readJson(res)).toEqual({ error: "Unauthorized" });
  });

  it("includes the caller-provided message in the JSON body", async () => {
    const res = unauthorized("login required");
    expect(res.status).toBe(401);
    expect(await readJson(res)).toEqual({ error: "login required" });
  });

  it("merges custom headers alongside WWW-Authenticate", async () => {
    const res = unauthorized(undefined, { headers: { "x-custom": "1" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("lets callers override WWW-Authenticate (e.g. Basic realm)", () => {
    const res = unauthorized("Token expired", {
      headers: { "WWW-Authenticate": 'Basic realm="app"' },
    });
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="app"');
  });
});

describe("forbidden()", () => {
  it("returns 403 with the default JSON body", async () => {
    const res = forbidden();
    expect(res.status).toBe(403);
    expect(await readJson(res)).toEqual({ error: "Forbidden" });
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("carries the provided message", async () => {
    const res = forbidden("role mismatch");
    expect(res.status).toBe(403);
    expect(await readJson(res)).toEqual({ error: "role mismatch" });
  });

  it("merges custom response headers", () => {
    const res = forbidden("no", { headers: { "x-trace": "abc" } });
    expect(res.headers.get("x-trace")).toBe("abc");
    expect(res.status).toBe(403);
  });
});

describe("badRequest()", () => {
  it("string input produces { error: <string> }", async () => {
    const res = badRequest("string-only");
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: "string-only" });
  });

  it("object input with message + errors produces { error, errors }", async () => {
    const res = badRequest({
      message: "invalid",
      errors: { email: ["required"] },
    });
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({
      error: "invalid",
      errors: { email: ["required"] },
    });
  });

  it("object input without errors omits the key (no `errors: undefined` leak)", async () => {
    const res = badRequest({ message: "simple" });
    const body = (await readJson(res)) as Record<string, unknown>;
    expect(body).toEqual({ error: "simple" });
    // Explicit: `errors` key must not appear at all — users pattern-match on presence.
    expect(Object.prototype.hasOwnProperty.call(body, "errors")).toBe(false);
  });

  it("no-args call defaults to 'Bad Request'", async () => {
    const res = badRequest();
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ error: "Bad Request" });
  });

  it("merges custom headers on both string and object inputs", () => {
    const resA = badRequest("x", { headers: { "x-a": "1" } });
    expect(resA.headers.get("x-a")).toBe("1");

    const resB = badRequest({ message: "y" }, { headers: { "x-b": "2" } });
    expect(resB.headers.get("x-b")).toBe("2");
  });

  it("response content-type is application/json; charset=utf-8", () => {
    const res = badRequest("z");
    const ct = res.headers.get("Content-Type") ?? "";
    expect(ct).toContain("application/json");
    expect(ct).toContain("charset=utf-8");
  });
});

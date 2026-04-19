/**
 * createTestSession — session fixture tests.
 *
 * Verifies cookie signing round-trip, storage reuse, extras injection,
 * and the convenience `readSession` helper.
 */
import { describe, expect, it } from "bun:test";
import {
  createTestSession,
  readSession,
  extractCookieValuePair,
} from "../../src/testing/index";
import { createCookieSessionStorage } from "../../src/filling/session";

describe("createTestSession", () => {
  it("produces a cookie header that round-trips via the same storage", async () => {
    const authed = await createTestSession({
      userId: "u_123",
      extras: { role: "admin" },
    });

    const session = await readSession(authed.storage, authed.cookieHeader);
    expect(session.get<string>("userId")).toBe("u_123");
    expect(session.get<string>("role")).toBe("admin");
  });

  it("persists a login timestamp by default", async () => {
    const before = Date.now();
    const authed = await createTestSession({ userId: "u_time" });
    const after = Date.now();

    const restored = await readSession(authed.storage, authed.cookieHeader);
    const loginAt = restored.get<number>("loginAt");
    expect(typeof loginAt).toBe("number");
    expect(loginAt!).toBeGreaterThanOrEqual(before);
    expect(loginAt!).toBeLessThanOrEqual(after);
  });

  it("honours a user-supplied loggedAt", async () => {
    const authed = await createTestSession({ userId: "u_x", loggedAt: 1 });
    const restored = await readSession(authed.storage, authed.cookieHeader);
    expect(restored.get<number>("loginAt")).toBe(1);
  });

  it("reuses a caller-provided storage instance", async () => {
    const externalStorage = createCookieSessionStorage({
      cookie: { secrets: ["external-secret"], secure: false },
    });
    const authed = await createTestSession({
      userId: "u_shared",
      storage: externalStorage,
    });
    expect(authed.storage).toBe(externalStorage);
    // A session built against the same storage instance round-trips —
    // ensures the fixture did not spin up a throwaway one.
    const restored = await readSession(externalStorage, authed.cookieHeader);
    expect(restored.get<string>("userId")).toBe("u_shared");
  });

  it("returns a headers object ready to spread into fetch init", async () => {
    const authed = await createTestSession({ userId: "u_h" });
    expect(Object.keys(authed.headers)).toEqual(["Cookie"]);
    expect(authed.headers.Cookie).toBe(authed.cookieHeader);
  });

  it("rejects empty userId with a TypeError", () => {
    expect(createTestSession({ userId: "" })).rejects.toThrow(TypeError);
  });
});

describe("extractCookieValuePair", () => {
  it("strips attribute segment", () => {
    const raw = "__session=value; Path=/; HttpOnly; SameSite=Lax";
    expect(extractCookieValuePair(raw)).toBe("__session=value");
  });

  it("returns input unchanged when no attribute segment present", () => {
    expect(extractCookieValuePair("a=b")).toBe("a=b");
  });
});

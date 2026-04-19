/**
 * createTestServer — integration fixture tests.
 *
 * Verifies ephemeral-port boot, handler registration round-trip, path-style
 * fetch resolution, absolute-URL fetch passthrough, idempotent close, and
 * Symbol.asyncDispose compatibility.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createTestServer, createTestManifest, type TestServer } from "../../src/testing/index";

describe("createTestServer — boot + teardown", () => {
  let server: TestServer | null = null;

  afterEach(() => {
    server?.close();
    server = null;
  });

  it("listens on an ephemeral port with a resolvable baseUrl", async () => {
    const manifest = createTestManifest([
      { id: "api/health", kind: "api", pattern: "/api/health", module: "test-health", methods: ["GET"] },
    ]);

    server = await createTestServer(manifest, {
      registerHandlers(reg) {
        reg.registerApiHandler("api/health", async () => Response.json({ ok: true }));
      },
    });

    expect(server.port).toBeGreaterThan(0);
    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("round-trips a live fetch via the scoped helper", async () => {
    const manifest = createTestManifest([
      { id: "api/echo", kind: "api", pattern: "/api/echo", module: "test-echo", methods: ["GET"] },
    ]);

    server = await createTestServer(manifest, {
      registerHandlers(reg) {
        reg.registerApiHandler("api/echo", async () => Response.json({ n: 42 }));
      },
    });

    const res = await server.fetch("/api/echo");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.n).toBe(42);
  });

  it("accepts absolute URLs on fetch without re-prefixing", async () => {
    const manifest = createTestManifest([
      { id: "api/abs", kind: "api", pattern: "/api/abs", module: "test-abs", methods: ["GET"] },
    ]);

    server = await createTestServer(manifest, {
      registerHandlers(reg) {
        reg.registerApiHandler("api/abs", async () => Response.json({ ok: true }));
      },
    });

    const absoluteUrl = `${server.baseUrl}/api/abs`;
    const res = await server.fetch(absoluteUrl);
    expect(res.status).toBe(200);
  });

  it("isolates handlers per-fixture (no global-registry bleed)", async () => {
    const manifestA = createTestManifest([
      { id: "api/same", kind: "api", pattern: "/api/same", module: "m-a", methods: ["GET"] },
    ]);
    const manifestB = createTestManifest([
      { id: "api/same", kind: "api", pattern: "/api/same", module: "m-b", methods: ["GET"] },
    ]);

    const a = await createTestServer(manifestA, {
      registerHandlers(reg) {
        reg.registerApiHandler("api/same", async () => Response.json({ which: "A" }));
      },
    });
    const b = await createTestServer(manifestB, {
      registerHandlers(reg) {
        reg.registerApiHandler("api/same", async () => Response.json({ which: "B" }));
      },
    });

    try {
      const resA = await a.fetch("/api/same");
      const resB = await b.fetch("/api/same");
      expect((await resA.json()).which).toBe("A");
      expect((await resB.json()).which).toBe("B");
    } finally {
      a.close();
      b.close();
    }
  });

  it("close() is idempotent", async () => {
    const manifest = createTestManifest([
      { id: "api/noop", kind: "api", pattern: "/api/noop", module: "test-noop", methods: ["GET"] },
    ]);
    const local = await createTestServer(manifest);
    local.close();
    // Second close must not throw.
    expect(() => local.close()).not.toThrow();
  });

  it("throws on fetch after close()", async () => {
    const manifest = createTestManifest([
      { id: "api/gone", kind: "api", pattern: "/api/gone", module: "test-gone", methods: ["GET"] },
    ]);
    const local = await createTestServer(manifest);
    local.close();
    await expect(local.fetch("/api/gone")).rejects.toThrow(/after close/);
  });

  it("Symbol.asyncDispose is callable and closes the server", async () => {
    const manifest = createTestManifest([
      { id: "api/d", kind: "api", pattern: "/api/d", module: "test-d", methods: ["GET"] },
    ]);
    const local = await createTestServer(manifest);
    await local[Symbol.asyncDispose]();
    await expect(local.fetch("/api/d")).rejects.toThrow(/after close/);
  });
});

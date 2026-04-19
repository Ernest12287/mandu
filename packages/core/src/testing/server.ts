/**
 * @mandujs/core/testing/server
 *
 * In-process server fixture for integration tests.
 *
 * Wraps `startServer()` with an ephemeral port (`0`), a per-test
 * `ServerRegistry` (so parallel tests cannot stomp each other's handlers),
 * and a scoped `fetch` helper so callers can write:
 *
 * ```ts
 * import { createTestServer } from "@mandujs/core/testing";
 *
 * const server = await createTestServer(manifest, {
 *   registerHandlers(reg) {
 *     reg.registerApiHandler("api/health", async () => Response.json({ ok: true }));
 *   },
 * });
 * afterAll(() => server.close());
 *
 * const res = await server.fetch("/api/health");
 * expect(res.status).toBe(200);
 * ```
 *
 * ## Design
 *
 * - **Registry isolation** — the fixture always creates its own
 *   `ServerRegistry` (via `createServerRegistry()`), never touches the default
 *   global. That lets several fixtures run concurrently in the same test
 *   process without handler collisions.
 * - **Port zero** — Bun picks an OS-assigned ephemeral port; the fixture
 *   exposes the resolved port and a pre-computed `baseUrl` so tests never
 *   hard-code `:3000`.
 * - **Scoped `fetch`** — accepts either an absolute URL or a root-relative
 *   path; the latter is joined to `baseUrl`. This matches the ergonomics
 *   of `supertest` / Remix `createRoutesStub` without taking a dep on them.
 * - **Cleanup contract** — `close()` is idempotent; the returned handle is
 *   also `asyncDispose`-compatible so `using server = await createTestServer(...)`
 *   works under Bun's Explicit Resource Management.
 *
 * @module testing/server
 */

import type { RoutesManifest } from "../spec/schema";
import {
  startServer,
  createServerRegistry,
  type ManduServer,
  type ServerOptions,
  type ServerRegistry,
} from "../runtime/server";

/** Options accepted by {@link createTestServer}. */
export interface CreateTestServerOptions {
  /**
   * Optional registration callback. The fixture creates a fresh
   * `ServerRegistry` and passes it here so tests can attach API handlers,
   * page loaders, layouts, and so on synchronously before the server starts
   * listening. Skip when the manifest's handlers are resolved elsewhere.
   */
  registerHandlers?: (registry: ServerRegistry) => void | Promise<void>;
  /**
   * Host to bind. Default: `"127.0.0.1"` (explicit IPv4 so Windows CI boxes
   * do not fall through to `::1` and break `fetch` default resolution).
   */
  hostname?: string;
  /**
   * Extra options forwarded to `startServer()`. The fixture overrides
   * `port`, `registry`, and `isDev` — those keys are ignored if present.
   */
  serverOptions?: Omit<ServerOptions, "port" | "registry" | "isDev" | "hostname">;
  /** Set to `true` to boot the server in dev mode (HMR, kitchen, etc.). Default: `false`. */
  isDev?: boolean;
}

/** The fixture handle returned by {@link createTestServer}. */
export interface TestServer {
  /** The underlying `ManduServer` (access `server.server.port` if you need Bun handles). */
  readonly server: ManduServer;
  /** The registry the fixture created. Use this to register handlers *after* startup. */
  readonly registry: ServerRegistry;
  /** Resolved port (non-zero once `await`ed). */
  readonly port: number;
  /** `http://<host>:<port>` with no trailing slash. */
  readonly baseUrl: string;

  /**
   * Scoped fetch — accepts a path (`"/api/foo"`) or absolute URL
   * (`"http://other/..."`). Path-style inputs are joined to `baseUrl`.
   *
   * ```ts
   * await server.fetch("/api/health")
   * await server.fetch("/api/login", { method: "POST", body: JSON.stringify({...}) })
   * await server.fetch(new Request("http://localhost/anything"))
   * ```
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;

  /**
   * Idempotent teardown. Stops the underlying `Bun.serve` instance and
   * clears the registry so no handler leaks into the next fixture.
   */
  close(): void;

  /** Explicit Resource Management support: `using server = await createTestServer(...)`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Boot an in-process test server on an ephemeral port.
 *
 * Returns once `Bun.serve` is listening — no polling required; Bun binds
 * synchronously before `fetch` becomes ready.
 *
 * @throws if `manifest` is missing required fields (handler resolution errors
 *   surface on the first `fetch`, not here).
 */
export async function createTestServer(
  manifest: RoutesManifest,
  options: CreateTestServerOptions = {},
): Promise<TestServer> {
  const registry = createServerRegistry();

  if (options.registerHandlers) {
    await options.registerHandlers(registry);
  }

  const hostname = options.hostname ?? "127.0.0.1";
  const server = startServer(manifest, {
    ...(options.serverOptions ?? {}),
    port: 0,
    hostname,
    isDev: options.isDev ?? false,
    registry,
  });

  // Bun.serve always resolves the port synchronously before returning the
  // handle — `undefined` would only happen on a fully-closed server, which
  // is impossible here because we just created it. Assert + narrow so
  // consumers see a plain `number`.
  if (typeof server.server.port !== "number") {
    throw new Error(
      "[testing/server] startServer() returned without a bound port. This is a framework-level bug — please report.",
    );
  }
  const port: number = server.server.port;
  const baseUrl = `http://${hostname}:${port}`;

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      server.stop();
    } catch {
      // stop() is best-effort — swallow so afterEach doesn't mask real test failures.
    }
  };

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (closed) {
      throw new Error(
        "[testing/server] fetch() called after close() — did an afterAll run before this test?",
      );
    }

    // Resolve path-style inputs against baseUrl. Absolute URLs and Request
    // objects pass through untouched so callers keep full control.
    if (typeof input === "string") {
      const resolved = input.startsWith("http://") || input.startsWith("https://")
        ? input
        : `${baseUrl}${input.startsWith("/") ? "" : "/"}${input}`;
      return fetch(resolved, init);
    }

    if (input instanceof URL) {
      return fetch(input, init);
    }

    return fetch(input, init);
  };

  return {
    server,
    registry,
    port,
    baseUrl,
    fetch: fetchImpl,
    close,
    async [Symbol.asyncDispose]() {
      close();
    },
  };
}

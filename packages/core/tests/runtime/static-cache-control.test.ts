/**
 * Issue #218 — Stable-URL static assets served with incorrect `immutable`
 * Cache-Control header.
 *
 * Historically Mandu stamped every `/.mandu/client/*` response with
 * `Cache-Control: public, max-age=31536000, immutable`, even when the
 * filename (`globals.css`, `runtime.js`) is *not* content-hashed. Browsers
 * treat `immutable` as a hard promise — users kept seeing stale CSS on
 * mandujs.com long after a deploy fixed the underlying bug.
 *
 * Contract tested here:
 *   1. Stable URL   → `public, max-age=0, must-revalidate` + strong ETag.
 *   2. Hashed URL   → `public, max-age=31536000, immutable` + strong ETag.
 *   3. Dev mode     → `no-cache, no-store, must-revalidate` regardless of
 *                     filename shape.
 *   4. Conditional GET (`If-None-Match`) round-trips 304 with empty body
 *      and preserves Cache-Control for both stable and hashed URLs.
 *   5. `*` and comma-separated `If-None-Match` forms match per RFC 7232.
 *   6. Re-hashing when file content changes produces a different ETag.
 *   7. Public/* static files retain their legacy 1-day cache policy —
 *      this fix is intentionally scoped to framework-emitted bundles.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startServer,
  createServerRegistry,
  __clearStaticEtagCacheForTests,
  type ManduServer,
  type ServerRegistry,
} from "../../src/runtime/server";
import type { RoutesManifest } from "../../src/spec/schema";
import path from "path";
import fs from "fs/promises";
import os from "os";

const emptyManifest: RoutesManifest = { version: 1, routes: [] };

// A single deterministic hashed filename — easy to assert in logs.
const HASHED_FILENAME = "chunk.a1b2c3d4e5f6.js";
const STABLE_FILENAME = "globals.css";
const STABLE_RUNTIME = "runtime.js";

describe("Issue #218 — static asset Cache-Control", () => {
  let server: ManduServer | null = null;
  let registry: ServerRegistry;
  let TEST_DIR: string;

  beforeEach(async () => {
    __clearStaticEtagCacheForTests();
    registry = createServerRegistry();
    TEST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "mandu-cache-hdr-"));
    await fs.mkdir(path.join(TEST_DIR, ".mandu", "client"), { recursive: true });
    await fs.mkdir(path.join(TEST_DIR, "public"), { recursive: true });

    await fs.writeFile(
      path.join(TEST_DIR, ".mandu", "client", STABLE_FILENAME),
      "body { color: red; }",
    );
    await fs.writeFile(
      path.join(TEST_DIR, ".mandu", "client", STABLE_RUNTIME),
      "/* stable runtime */",
    );
    await fs.writeFile(
      path.join(TEST_DIR, ".mandu", "client", HASHED_FILENAME),
      "/* hashed chunk */",
    );
    await fs.writeFile(
      path.join(TEST_DIR, "public", "logo.png"),
      "fake-png",
    );
  });

  afterEach(async () => {
    if (server) {
      server.stop();
      server = null;
    }
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  // ── Policy: stable URL → must-revalidate ──────────────────────────────

  it("stable bundle URL (globals.css) gets `must-revalidate`, NOT immutable", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
      // isDev defaults to false → production policy
    });
    const res = await fetch(
      `http://localhost:${server.server.port}/.mandu/client/${STABLE_FILENAME}`,
    );

    expect(res.status).toBe(200);
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toBe("public, max-age=0, must-revalidate");
    expect(cc).not.toContain("immutable");
    expect(cc).not.toMatch(/max-age=(?!0\b)/);
  });

  it("stable runtime.js also gets `must-revalidate`", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const res = await fetch(
      `http://localhost:${server.server.port}/.mandu/client/${STABLE_RUNTIME}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  // ── Policy: hashed URL → immutable ────────────────────────────────────

  it("hashed bundle URL gets `immutable` 1-year cache", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const res = await fetch(
      `http://localhost:${server.server.port}/.mandu/client/${HASHED_FILENAME}`,
    );

    expect(res.status).toBe(200);
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("immutable");
    expect(cc).toContain("max-age=31536000");
  });

  // ── Policy: dev mode ──────────────────────────────────────────────────

  it("dev mode forces no-cache regardless of filename shape", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
      isDev: true,
    });
    const port = server.server.port;

    for (const name of [STABLE_FILENAME, HASHED_FILENAME, STABLE_RUNTIME]) {
      const res = await fetch(`http://localhost:${port}/.mandu/client/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "no-cache, no-store, must-revalidate",
      );
    }
  });

  // ── ETag emission ────────────────────────────────────────────────────

  it("bundle responses emit a strong ETag (no `W/` prefix)", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const res = await fetch(
      `http://localhost:${server.server.port}/.mandu/client/${STABLE_FILENAME}`,
    );

    const etag = res.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(etag!.startsWith("\"")).toBe(true);
    expect(etag!.startsWith("W/")).toBe(false);
    expect(etag!).toMatch(/^"[a-z0-9]+"$/);
  });

  it("different content under same URL yields a different ETag", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const port = server.server.port;
    const url = `http://localhost:${port}/.mandu/client/${STABLE_FILENAME}`;

    const etagA = (await fetch(url)).headers.get("ETag");

    // Rewrite file + bump mtime so cache-key changes deterministically
    // (1s guarantees mtime bucket change on FAT-like filesystems too).
    await new Promise((r) => setTimeout(r, 1100));
    await fs.writeFile(
      path.join(TEST_DIR, ".mandu", "client", STABLE_FILENAME),
      "body { color: BLUE; /* new payload */ }",
    );

    const etagB = (await fetch(url)).headers.get("ETag");
    expect(etagA).toBeTruthy();
    expect(etagB).toBeTruthy();
    expect(etagA).not.toBe(etagB);
  });

  // ── Conditional GET (304) ────────────────────────────────────────────

  it("If-None-Match round-trip produces 304 with empty body (stable URL)", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const port = server.server.port;
    const url = `http://localhost:${port}/.mandu/client/${STABLE_FILENAME}`;

    const first = await fetch(url);
    const etag = first.headers.get("ETag")!;
    await first.text();

    const second = await fetch(url, { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    // Cache-Control must still be present on 304 so intermediaries update
    // their freshness state.
    expect(second.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate",
    );

    const body = await second.arrayBuffer();
    expect(body.byteLength).toBe(0);
  });

  it("If-None-Match round-trip produces 304 (hashed URL) with immutable CC", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const port = server.server.port;
    const url = `http://localhost:${port}/.mandu/client/${HASHED_FILENAME}`;

    const etag = (await fetch(url)).headers.get("ETag")!;
    const cond = await fetch(url, { headers: { "If-None-Match": etag } });

    expect(cond.status).toBe(304);
    expect(cond.headers.get("Cache-Control")).toContain("immutable");
  });

  it("mismatched If-None-Match falls through to 200 with body", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const res = await fetch(
      `http://localhost:${server.server.port}/.mandu/client/${STABLE_FILENAME}`,
      { headers: { "If-None-Match": "\"not-the-right-hash\"" } },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("color: red");
  });

  it("If-None-Match `*` matches any current representation", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const res = await fetch(
      `http://localhost:${server.server.port}/.mandu/client/${STABLE_FILENAME}`,
      { headers: { "If-None-Match": "*" } },
    );
    expect(res.status).toBe(304);
  });

  it("If-None-Match comma-separated list matches if any entry matches", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const port = server.server.port;
    const url = `http://localhost:${port}/.mandu/client/${STABLE_FILENAME}`;

    const etag = (await fetch(url)).headers.get("ETag")!;
    const res = await fetch(url, {
      headers: { "If-None-Match": `"old-etag", ${etag}, "other"` },
    });
    expect(res.status).toBe(304);
  });

  it("weak-form If-None-Match (`W/...`) matches strong server ETag", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const port = server.server.port;
    const url = `http://localhost:${port}/.mandu/client/${STABLE_FILENAME}`;

    const strongEtag = (await fetch(url)).headers.get("ETag")!;
    // Client sends the same opaque string but with a W/ prefix (some CDNs
    // downgrade strong ETags to weak on rewrite) — RFC 7232 weak compare.
    const weakForm = `W/${strongEtag}`;
    const res = await fetch(url, { headers: { "If-None-Match": weakForm } });
    expect(res.status).toBe(304);
  });

  // ── Scope: public/* keeps legacy policy ──────────────────────────────

  it("non-bundle /public/* files retain the legacy 1-day cache", async () => {
    server = startServer(emptyManifest, {
      port: 0,
      rootDir: TEST_DIR,
      registry,
    });
    const res = await fetch(
      `http://localhost:${server.server.port}/public/logo.png`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    // Public files keep weak ETag — the fix is intentionally scoped to
    // framework-emitted bundles under /.mandu/client/.
    expect(res.headers.get("ETag")).toMatch(/^W\//);
  });
});

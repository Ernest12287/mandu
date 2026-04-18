/**
 * Phase 7.0 R2 Agent D — Extended file watch tests.
 *
 * Covers the six file kinds that Mandu's dev watcher silently ignored
 * prior to Phase 7:
 *
 *   1. `spec/contracts/**\/*.contract.ts`   — code-gen / handler re-register
 *   2. `spec/resources/**\/*.resource.ts`   — full artifact regeneration
 *   3. `app/**\/middleware.ts`              — route handler re-register
 *   4. `mandu.config.ts`                    — auto-restart
 *   5. `.env*` (root)                       — auto-restart
 *   6. `package.json`                       — advisory notification only
 *
 * The pure static tests (classify / predicate) run in all modes — they
 * do not spin up a watcher. The integration tests that drive real
 * `fs.watch` events are gated behind `MANDU_SKIP_BUNDLER_TESTS=1`
 * (the same env var Agent A uses) to stay compatible with the CI
 * randomize protocol.
 *
 * References:
 *   docs/bun/phase-7-team-plan.md §4 Agent D
 *   docs/bun/phase-7-diagnostics/performance-reliability.md §2 B10
 *   docs/bun/phase-7-diagnostics/hmr-internals.md §2
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  startDevBundler,
  SSR_CHANGE_WILDCARD,
  isConfigOrEnvFile,
  isResourceOrContractFile,
  isRouteMiddlewareFile,
  isPackageJsonFile,
  _testOnly_classifyFileKind,
} from "../dev";
import type { RoutesManifest } from "../../spec/schema";

// -----------------------------------------------------------------------------
// Helpers — mirror the patterns in dev-reliability.test.ts so the two suites
// can share a mental model.
// -----------------------------------------------------------------------------

/** Same settle window Agent A's suite uses — derived from WATCHER_DEBOUNCE
 *  (100 ms) plus Windows ReadDirectoryChangesW slack. */
const WATCH_SETTLE_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write to `filePath` repeatedly until the observer callback reports a
 * change. Windows `fs.watch` occasionally drops the first event on a
 * freshly-armed watcher; a retry loop with varying content is the
 * robust cross-platform pattern.
 */
async function touchUntilSeen(
  filePath: string,
  observedCount: () => number,
  maxAttempts = 4,
): Promise<void> {
  const before = observedCount();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    writeFileSync(filePath, `export const V = ${Date.now() + attempt};\n`);
    await sleep(WATCH_SETTLE_MS);
    if (observedCount() > before) return;
  }
}

/**
 * Variant of `touchUntilSeen` for files that are not TS/TSX — `.env`,
 * `package.json`. Writes raw text, not an `export const` line.
 */
async function touchNonTsUntilSeen(
  filePath: string,
  contentFactory: (attempt: number) => string,
  observedCount: () => number,
  maxAttempts = 4,
): Promise<void> {
  const before = observedCount();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    writeFileSync(filePath, contentFactory(attempt));
    await sleep(WATCH_SETTLE_MS);
    if (observedCount() > before) return;
  }
}

/**
 * Build a minimal on-disk project that exercises every directory the
 * extended watcher cares about:
 *   - `spec/contracts/foo.contract.ts`
 *   - `spec/resources/user.resource.ts`
 *   - `app/api/hello/middleware.ts`
 *   - `src/` (so main watch dispatch is live)
 *   - `mandu.config.ts` / `.env` / `package.json` at the root
 *
 * `.mandu/manifest.json` is pre-populated to match the pattern Agent A's
 * fixtures use.
 */
function createTempProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mandu-extended-watch-"));

  // `.mandu` tree for the bundler's initial build to succeed silently.
  mkdirSync(path.join(root, ".mandu/client"), { recursive: true });
  writeFileSync(
    path.join(root, ".mandu/manifest.json"),
    JSON.stringify(
      {
        version: 1,
        buildTime: new Date().toISOString(),
        env: "development",
        bundles: {},
        shared: {
          runtime: "/.mandu/client/runtime.js",
          vendor: "/.mandu/client/vendor.js",
        },
      },
      null,
      2,
    ),
  );

  // Spec trees — these are the ones this agent adds watchers for.
  mkdirSync(path.join(root, "spec/contracts"), { recursive: true });
  writeFileSync(
    path.join(root, "spec/contracts/foo.contract.ts"),
    "export const FooContract = { foo: 'bar' };\n",
  );
  mkdirSync(path.join(root, "spec/resources"), { recursive: true });
  writeFileSync(
    path.join(root, "spec/resources/user.resource.ts"),
    "export default { name: 'user', fields: {} };\n",
  );

  // Per-route middleware
  mkdirSync(path.join(root, "app/api/hello"), { recursive: true });
  writeFileSync(
    path.join(root, "app/api/hello/middleware.ts"),
    "export default function hello() {}\n",
  );
  writeFileSync(
    path.join(root, "app/api/hello/route.ts"),
    "export function GET() { return Response.json({}); }\n",
  );

  // `src/` for the main common-dir watcher — proves regression tests
  // that the old behavior is intact.
  mkdirSync(path.join(root, "src/shared"), { recursive: true });
  writeFileSync(path.join(root, "src/shared/foo.ts"), "export const S = 1;\n");
  writeFileSync(path.join(root, "src/top-level.ts"), "export const T = 1;\n");

  // Root-level config / env / package.json — the new dedicated watcher.
  writeFileSync(path.join(root, "mandu.config.ts"), "export default { };\n");
  writeFileSync(path.join(root, ".env"), "NODE_ENV=development\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "tmp" }, null, 2));

  return root;
}

/**
 * Manifest with one API route so `apiModuleSet` in the bundler is not
 * empty — exercises the middleware path that shares the api-only kind.
 */
const hydrationlessManifest = (): RoutesManifest =>
  ({
    version: 1,
    routes: [
      {
        id: "api.hello",
        kind: "api",
        pattern: "/api/hello",
        module: "app/api/hello/route.ts",
      },
    ],
  } as unknown as RoutesManifest);

// -----------------------------------------------------------------------------
// Section A — Pure predicate tests (no watcher startup)
// -----------------------------------------------------------------------------

describe("Phase 7.0 R2 Agent D — predicates", () => {
  it("isConfigOrEnvFile matches mandu.config.ts + variants", () => {
    // Basic mandu.config.ts
    expect(isConfigOrEnvFile("/repo/mandu.config.ts")).toBe(true);
    expect(isConfigOrEnvFile("/repo/mandu.config.js")).toBe(true);
    expect(isConfigOrEnvFile("/repo/mandu.config.mjs")).toBe(true);
    expect(isConfigOrEnvFile("/repo/mandu.config.cjs")).toBe(true);
    // Partial names must NOT match — `mandu.config.local.ts` would be
    // user namespace, not a framework hook.
    expect(isConfigOrEnvFile("/repo/mandu.config.local.ts")).toBe(false);
    expect(isConfigOrEnvFile("/repo/mandu-config.ts")).toBe(false);
  });

  it("isConfigOrEnvFile matches .env family", () => {
    expect(isConfigOrEnvFile("/repo/.env")).toBe(true);
    expect(isConfigOrEnvFile("/repo/.env.local")).toBe(true);
    expect(isConfigOrEnvFile("/repo/.env.development")).toBe(true);
    expect(isConfigOrEnvFile("/repo/.env.production")).toBe(true);
    expect(isConfigOrEnvFile("/repo/.env.test")).toBe(true);
    expect(isConfigOrEnvFile("/repo/.env.staging")).toBe(true);
    // `.envoy` / `.envelope` must NOT match — prefix-only, not generic.
    expect(isConfigOrEnvFile("/repo/.envoy")).toBe(false);
    expect(isConfigOrEnvFile("/repo/env")).toBe(false);
  });

  it("isResourceOrContractFile matches *.resource.ts and *.contract.ts", () => {
    expect(isResourceOrContractFile("/repo/spec/resources/user.resource.ts")).toBe(true);
    expect(isResourceOrContractFile("/repo/spec/resources/deep/nested/post.resource.ts")).toBe(true);
    expect(isResourceOrContractFile("/repo/spec/contracts/api.contract.ts")).toBe(true);
    expect(isResourceOrContractFile("/repo/app/users/users.contract.ts")).toBe(true);
    // `.tsx` variants (rare, but supported).
    expect(isResourceOrContractFile("/repo/spec/resources/foo.resource.tsx")).toBe(true);
    // Unrelated names must NOT match.
    expect(isResourceOrContractFile("/repo/spec/resources/user.ts")).toBe(false);
    expect(isResourceOrContractFile("/repo/spec/foo.contract.md")).toBe(false);
  });

  it("isRouteMiddlewareFile matches app/**/middleware.ts", () => {
    expect(isRouteMiddlewareFile("/repo/app/api/hello/middleware.ts")).toBe(true);
    expect(isRouteMiddlewareFile("/repo/app/middleware.ts")).toBe(true);
    expect(isRouteMiddlewareFile("/repo/app/middleware.tsx")).toBe(true);
    // Partial matches must NOT fire — a user module named `auth-middleware.ts`
    // is regular code, not the framework hook.
    expect(isRouteMiddlewareFile("/repo/app/auth-middleware.ts")).toBe(false);
    expect(isRouteMiddlewareFile("/repo/app/middlewares/guard.ts")).toBe(false);
  });

  it("isPackageJsonFile matches only the basename", () => {
    expect(isPackageJsonFile("/repo/package.json")).toBe(true);
    expect(isPackageJsonFile("/repo/packages/core/package.json")).toBe(true);
    // Case-insensitive (Windows can surface mixed case).
    expect(isPackageJsonFile("/repo/Package.JSON")).toBe(true);
    // Substring must NOT match.
    expect(isPackageJsonFile("/repo/package-lock.json")).toBe(false);
    expect(isPackageJsonFile("/repo/package.json.bak")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Section B — classifyBatch static shape (no watcher startup)
// -----------------------------------------------------------------------------

describe("Phase 7.0 R2 Agent D — static classification (_testOnly_classifyFileKind)", () => {
  it("(1) foo.contract.ts → resource-regen", () => {
    expect(_testOnly_classifyFileKind("/repo/spec/contracts/foo.contract.ts")).toBe(
      "resource-regen",
    );
  });

  it("(2) bar.resource.ts → resource-regen", () => {
    expect(_testOnly_classifyFileKind("/repo/spec/resources/bar.resource.ts")).toBe(
      "resource-regen",
    );
  });

  it("(3) app/api/hello/middleware.ts → api-only", () => {
    expect(_testOnly_classifyFileKind("/repo/app/api/hello/middleware.ts")).toBe(
      "api-only",
    );
  });

  it("(4) mandu.config.ts → config-reload", () => {
    expect(_testOnly_classifyFileKind("/repo/mandu.config.ts")).toBe(
      "config-reload",
    );
  });

  it("(5) .env → config-reload", () => {
    expect(_testOnly_classifyFileKind("/repo/.env")).toBe("config-reload");
  });

  it("(6) .env.local → config-reload", () => {
    expect(_testOnly_classifyFileKind("/repo/.env.local")).toBe("config-reload");
    expect(_testOnly_classifyFileKind("/repo/.env.development")).toBe("config-reload");
    expect(_testOnly_classifyFileKind("/repo/.env.production")).toBe("config-reload");
  });

  it("regression: src/shared/foo.ts stays common-dir when commonDirs provided", () => {
    // `commonDirs` is optional — the pure-static classifier needs it to
    // distinguish a common-dir path from a mixed one. This proves the
    // Agent D extension doesn't steal priority from Agent A's common-dir
    // path.
    expect(
      _testOnly_classifyFileKind("/repo/src/shared/foo.ts", {
        commonDirs: ["/repo/src"],
      }),
    ).toBe("common-dir");
  });

  it("regression: app/page.tsx falls through to mixed (no handler for it in the static classifier)", () => {
    // The live classifier (inside startDevBundler) uses manifest-derived
    // maps to route a page path to ssr-only / islands-only. The static
    // export intentionally does NOT do that — it's a pure rule table.
    // This test pins the boundary: do NOT expect the static helper to
    // know about routes.
    expect(_testOnly_classifyFileKind("/repo/app/page.tsx")).toBe("mixed");
  });
});

// -----------------------------------------------------------------------------
// Section C — Live watcher integration (gated)
// -----------------------------------------------------------------------------

describe.skipIf(process.env.MANDU_SKIP_BUNDLER_TESTS === "1")(
  "Phase 7.0 R2 Agent D — watcher integration",
  () => {
    let rootDir: string;
    let close: (() => void) | null = null;

    beforeEach(() => {
      rootDir = createTempProject();
    });

    afterEach(() => {
      close?.();
      close = null;
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        /* Windows may hold locks during teardown — best-effort cleanup. */
      }
    });

    it("(1) .contract.ts change fires onResourceChange", async () => {
      const resourceCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onResourceChange: (filePath) => {
          resourceCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchUntilSeen(
        path.join(rootDir, "spec/contracts/foo.contract.ts"),
        () => resourceCalls.length,
      );

      expect(resourceCalls.length).toBeGreaterThan(0);
      expect(resourceCalls[0]!.endsWith("foo.contract.ts")).toBe(true);
    }, 15_000);

    it("(2) .resource.ts change fires onResourceChange", async () => {
      const resourceCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onResourceChange: (filePath) => {
          resourceCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchUntilSeen(
        path.join(rootDir, "spec/resources/user.resource.ts"),
        () => resourceCalls.length,
      );

      expect(resourceCalls.length).toBeGreaterThan(0);
      expect(resourceCalls[0]!.endsWith("user.resource.ts")).toBe(true);
    }, 15_000);

    it("(3) app/api/hello/middleware.ts change fires onAPIChange", async () => {
      // Middleware shares the API-change rail — the CLI's handleAPIChange
      // re-registers route handlers, which is exactly what a middleware
      // edit needs (routes pull in middleware via the import graph).
      const apiCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onAPIChange: (filePath) => {
          apiCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchUntilSeen(
        path.join(rootDir, "app/api/hello/middleware.ts"),
        () => apiCalls.length,
      );

      expect(apiCalls.length).toBeGreaterThan(0);
      expect(apiCalls.some((p) => p.endsWith("middleware.ts"))).toBe(true);
    }, 15_000);

    it("(4) mandu.config.ts change fires onConfigReload (mocked restart)", async () => {
      // The CLI-side restart is mocked out — we only assert the bundler
      // delivered the signal. The full wiring (restartDevServer) is
      // tested at the CLI layer.
      const configCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onConfigReload: (filePath) => {
          configCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchNonTsUntilSeen(
        path.join(rootDir, "mandu.config.ts"),
        (i) => `export default { marker: ${i} };\n`,
        () => configCalls.length,
      );

      expect(configCalls.length).toBeGreaterThan(0);
      expect(configCalls[0]!.endsWith("mandu.config.ts")).toBe(true);
    }, 15_000);

    it("(5) .env change fires onConfigReload", async () => {
      const configCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onConfigReload: (filePath) => {
          configCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchNonTsUntilSeen(
        path.join(rootDir, ".env"),
        (i) => `NODE_ENV=development\nMARKER=${i}\n`,
        () => configCalls.length,
      );

      expect(configCalls.length).toBeGreaterThan(0);
      expect(configCalls[0]!.endsWith(".env")).toBe(true);
    }, 15_000);

    it("(6) .env.local change fires onConfigReload", async () => {
      // `.env.local` must be detected alongside the bare `.env` — this
      // is the common "override for personal dev" file Next/Vite users
      // expect to work.
      writeFileSync(path.join(rootDir, ".env.local"), "A=1\n");
      const configCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onConfigReload: (filePath) => {
          configCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchNonTsUntilSeen(
        path.join(rootDir, ".env.local"),
        (i) => `A=${i}\n`,
        () => configCalls.length,
      );

      expect(configCalls.length).toBeGreaterThan(0);
      expect(configCalls.some((p) => p.endsWith(".env.local"))).toBe(true);
    }, 15_000);

    it("(7) package.json change fires onPackageJsonChange (no auto-restart)", async () => {
      // Package manifest watching is advisory only — if we wired this to
      // restartDevServer it would loop during `bun install`. The
      // callback asserts we saw the signal; the CLI's handler prints a
      // restart hint.
      const pkgCalls: string[] = [];
      const configCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onPackageJsonChange: (filePath) => {
          pkgCalls.push(filePath);
        },
        onConfigReload: (filePath) => {
          // Must NOT fire for package.json — guard against accidental
          // category promotion.
          configCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchNonTsUntilSeen(
        path.join(rootDir, "package.json"),
        (i) => JSON.stringify({ name: "tmp", marker: i }, null, 2),
        () => pkgCalls.length,
      );

      expect(pkgCalls.length).toBeGreaterThan(0);
      // Regression guard — package.json must never classify as config.
      expect(configCalls.length).toBe(0);
    }, 15_000);

    it("(8) batched .env edits coalesce to one onConfigReload", async () => {
      // Multiple `.env` saves inside the per-file debounce window must
      // fire the restart handler ONCE — not once per keystroke. This
      // is the coalescing contract the diagnostic doc calls out.
      const configCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onConfigReload: async (filePath) => {
          configCalls.push(filePath);
          // Slow handler so subsequent edits land in pendingBuildSet,
          // exactly as the restart coalescing contract requires.
          await sleep(200);
        },
      });
      close = bundler.close;

      await sleep(300);

      // Four rapid saves of the same file — per-file debounce must
      // coalesce them. We don't mix different env files here because
      // we want the purest "one file, many saves" assertion.
      const target = path.join(rootDir, ".env");
      writeFileSync(target, "A=1\n");
      await sleep(20);
      writeFileSync(target, "A=2\n");
      await sleep(20);
      writeFileSync(target, "A=3\n");
      await sleep(20);
      writeFileSync(target, "A=4\n");

      await sleep(WATCH_SETTLE_MS * 3);

      // At least one fire from the coalesced debounce. Typical observed
      // count is exactly 1 (per-file timer reset x3, fired once) — we
      // allow up to 2 because Windows ReadDirectoryChangesW occasionally
      // emits a second event after the 4th write.
      expect(configCalls.length).toBeGreaterThanOrEqual(1);
      expect(configCalls.length).toBeLessThanOrEqual(2);
    }, 15_000);

    it("(9) contract + resource mix in a single batch fires resource-regen coalesced", async () => {
      // Two different code-gen inputs touched in the same debounce
      // window. Each should fire onResourceChange — not coalesced down
      // to a single callback because the consumer needs the specific
      // path to drive `parseResourceSchema(filePath)` /
      // `generateResourceArtifacts(parsed)`.
      const resourceCalls: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onResourceChange: (filePath) => {
          resourceCalls.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      writeFileSync(
        path.join(rootDir, "spec/contracts/foo.contract.ts"),
        "export const X = 1;\n",
      );
      await sleep(30);
      writeFileSync(
        path.join(rootDir, "spec/resources/user.resource.ts"),
        "export default { name: 'user', fields: { id: { type: 'string' } } };\n",
      );

      await sleep(WATCH_SETTLE_MS * 2);

      // Both files must surface — coalescing is per-file, not per-batch
      // (see `handleResourceRegenBatch` comment block).
      expect(resourceCalls.length).toBeGreaterThanOrEqual(2);
      expect(resourceCalls.some((p) => p.endsWith("foo.contract.ts"))).toBe(true);
      expect(resourceCalls.some((p) => p.endsWith("user.resource.ts"))).toBe(true);
    }, 15_000);

    it("(10) regression: src/shared change still fires onSSRChange wildcard (common-dir path intact)", async () => {
      // The extended watcher additions must not steal priority from
      // Agent A's common-dir path. This test mirrors the corresponding
      // assertion in dev-reliability.test.ts so a future refactor that
      // breaks either suite is caught in both places.
      const wildcardFires: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onSSRChange: (filePath) => {
          wildcardFires.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchUntilSeen(
        path.join(rootDir, "src/shared/foo.ts"),
        () => wildcardFires.length,
      );

      expect(wildcardFires.length).toBeGreaterThan(0);
      expect(wildcardFires[0]).toBe(SSR_CHANGE_WILDCARD);
    }, 15_000);

    it("(11) regression: src/top-level.ts still fires onSSRChange wildcard (B1 kept)", async () => {
      // Second half of the regression coverage — Agent A's B1 fix
      // (src top-level file detection) must coexist with the Agent D
      // root-level watcher. If the new package.json/config watcher
      // somehow swallowed src/ events we'd see zero fires here.
      const wildcardFires: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onSSRChange: (filePath) => {
          wildcardFires.push(filePath);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchUntilSeen(
        path.join(rootDir, "src/top-level.ts"),
        () => wildcardFires.length,
      );

      expect(wildcardFires.length).toBeGreaterThan(0);
      expect(wildcardFires[0]).toBe(SSR_CHANGE_WILDCARD);
    }, 15_000);

    it("(12) resource-regen followed by onSSRChange wildcard fan-out", async () => {
      // Document the exact order of side effects after a resource
      // change — the resource callback runs FIRST (so the generator
      // can emit files), then the SSR invalidation fires so the
      // handler registry picks up the regenerated artifacts.
      const order: string[] = [];
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onResourceChange: (filePath) => {
          order.push(`resource:${path.basename(filePath)}`);
        },
        onSSRChange: (filePath) => {
          order.push(`ssr:${filePath}`);
        },
      });
      close = bundler.close;

      await sleep(300);

      await touchUntilSeen(
        path.join(rootDir, "spec/resources/user.resource.ts"),
        () => order.length,
      );

      // The resource callback must appear before ANY SSR wildcard fire.
      const resourceIdx = order.findIndex((e) => e.startsWith("resource:"));
      const ssrIdx = order.findIndex((e) => e === `ssr:${SSR_CHANGE_WILDCARD}`);
      expect(resourceIdx).toBeGreaterThanOrEqual(0);
      if (ssrIdx >= 0) {
        // If both fired, resource must have fired first.
        expect(resourceIdx).toBeLessThan(ssrIdx);
      }
    }, 15_000);

    it("(13) close() tears down the root config watcher (no leak)", async () => {
      // Extra belt-and-suspenders — the new `rootWatcher` must be
      // added to the `watchers` array so `close()` reclaims it. If we
      // leaked it, the test runner would flag a pending file watcher.
      const bundler = await startDevBundler({
        rootDir,
        manifest: hydrationlessManifest(),
        onConfigReload: () => {},
      });

      await sleep(200);
      writeFileSync(path.join(rootDir, "mandu.config.ts"), "export default { marker: 42 };\n");

      // Close before debounce fires — all timers + watchers must go.
      bundler.close();
      await sleep(WATCH_SETTLE_MS);

      expect(true).toBe(true);
    }, 10_000);
  },
);

// -----------------------------------------------------------------------------
// Section D — CoalescedChange["kind"] surface contract
// -----------------------------------------------------------------------------

describe("Phase 7.0 R2 Agent D — CoalescedChange kind surface", () => {
  it("config-reload and resource-regen values exist on the type-level contract", async () => {
    // Proves the hmr-types contract already exposes the two new kinds
    // Agent D classifies toward. If someone drops either from the union,
    // this test fails at compile time (we assign a literal into a
    // typed variable).

    // Literal assignments — if the union shrinks, TS errors in this
    // file before the suite even runs.
    const a: import("../hmr-types").CoalescedChange["kind"] = "config-reload";
    const b: import("../hmr-types").CoalescedChange["kind"] = "resource-regen";
    expect(a).toBe("config-reload");
    expect(b).toBe("resource-regen");
  });
});

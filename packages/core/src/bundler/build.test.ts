import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import type { RoutesManifest } from "../spec/schema";
import type { BundleResult } from "./types";
import { buildClientBundles } from "./build";

// 모든 테스트가 하나의 빌드 결과를 공유 — 병렬 Bun.build 충돌 방지
let rootDir: string;
let result: BundleResult;

async function importBuiltModule(relativePath: string): Promise<Record<string, unknown>> {
  const fileUrl = pathToFileURL(path.join(rootDir, relativePath)).href;
  return import(`${fileUrl}?t=${Date.now()}`);
}

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(import.meta.dir, ".tmp-bundler-"));

  await mkdir(path.join(rootDir, "app"), { recursive: true });
  await writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "mandu-build-test", type: "module" }, null, 2),
    "utf-8",
  );
  await writeFile(
    path.join(rootDir, "app", "demo.client.tsx"),
    "export default function DemoIsland() { return null; }\n",
    "utf-8",
  );

  const manifest: RoutesManifest = {
    version: 1,
    routes: [
      {
        id: "demo",
        kind: "page",
        pattern: "/",
        module: "app/page.tsx",
        componentModule: "app/page.tsx",
        clientModule: "app/demo.client.tsx",
        hydration: {
          strategy: "island",
          priority: "visible",
          preload: false,
        },
      },
    ],
  };

  result = await buildClientBundles(manifest, rootDir, {
    minify: false,
    sourcemap: false,
    splitting: false,
  });
});

afterAll(async () => {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// Historical note — `MANDU_SKIP_BUNDLER_TESTS` gate REMOVED.
//
// A previous revision gated this describe block behind
// `describe.skipIf(MANDU_SKIP_BUNDLER_TESTS === "1")` because running
// `bun test src/bundler/` without the gate hung indefinitely on Windows
// (see Phase 0.6 and `docs/qa/wave-R2-integration-report.md`). Root cause
// was NOT actually in THIS file — it was a deadlock in `safe-build.test.ts`'s
// "slot handoff" regression test, which drove Bun's microtask queue with a
// `while (!stop) { await Promise.resolve() }` sampler. That starved libuv
// I/O callbacks, so the 7 parallel `safeBuild()` calls never completed, the
// whole test process hung, and downstream test files (including this one
// when run in the same invocation) looked flaky when they were simply
// never reached. The handoff sampler now yields via `setImmediate`, which
// unblocks Bun.build completion and makes `bun test src/bundler/` finish
// deterministically in ~35s on Windows. Confirmed green 3/3 runs without
// the gate on 2026-04-20. If you are tempted to re-introduce the skip here,
// first check whether a sibling test is starving the event loop.
describe("buildClientBundles vendor shims", () => {
  test("build succeeds", () => {
    if (!result.success) {
      console.error("[build.test] errors:", result.errors);
    }
    expect(result.success).toBe(true);
  });

  test("re-exports modern React 19 APIs used by islands", async () => {
    const reactShim = await importBuiltModule(".mandu/client/_react.js");
    const requiredExports = [
      "Activity",
      "__COMPILER_RUNTIME",
      "cache",
      "cacheSignal",
      "startTransition",
      "use",
      "useActionState",
      "useEffectEvent",
      "useOptimistic",
      "unstable_useCacheRefresh",
    ];

    for (const exportName of requiredExports) {
      expect(exportName in reactShim).toBe(true);
    }
  });

  test("re-exports modern react-dom and react-dom/client APIs", async () => {
    const reactDomShim = await importBuiltModule(".mandu/client/_react-dom.js");
    for (const exportName of [
      "preconnect",
      "prefetchDNS",
      "preinit",
      "preinitModule",
      "preload",
      "preloadModule",
      "requestFormReset",
      "unstable_batchedUpdates",
      "useFormState",
      "useFormStatus",
    ]) {
      expect(exportName in reactDomShim).toBe(true);
    }

    const reactDomClientShim = await importBuiltModule(".mandu/client/_react-dom-client.js");
    for (const exportName of ["createRoot", "hydrateRoot", "version"]) {
      expect(exportName in reactDomClientShim).toBe(true);
    }
  });

  test("embeds hydration guards for deferred trigger strategies", async () => {
    const runtimeSource = await readFile(path.join(rootDir, ".mandu", "client", "_runtime.js"), "utf-8");
    expect(runtimeSource).toContain("function resolveHydrationTarget");
    expect(runtimeSource).toContain("function hasHydratableMarkup");
    expect(runtimeSource).toContain("function shouldHydrateCompiledIsland");
    expect(runtimeSource).toContain("onRecoverableError");
    expect(runtimeSource).toContain("data-mandu-hydrating");
    expect(runtimeSource).toContain("data-mandu-render-mode");
    expect(runtimeSource).toContain("data-mandu-recoverable-error");
    expect(runtimeSource).toContain("pointerdown");
  });
});

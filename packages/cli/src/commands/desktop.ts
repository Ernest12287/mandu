/**
 * mandu desktop — scaffolding & build glue for desktop targets.
 *
 * Phase 9c R1.D. Complements `mandu dev --target=desktop` and
 * `mandu build --target=desktop` by:
 *
 *   1. Emitting a minimal `src/desktop/main.ts` entry when the project does
 *      not already have one. The entry boots `startServer()` on `port: 0`,
 *      spawns a Worker for the Webview, and wires graceful shutdown.
 *   2. Running `mandu build` (client bundles + manifest) so the generated
 *      entry has `./.mandu/manifest.json` to import from.
 *   3. Printing a copy-pasteable `bun build --compile` command for single
 *      binary distribution. The actual compile is Phase 9b (B-agent) — we
 *      link to that here rather than duplicating their template embedding.
 *
 * Non-goals:
 *   - Code signing (Phase 9b.C / R3 security track).
 *   - Packaging installers (MSI, DMG, AppImage) — follow-up phase.
 */

import path from "path";
import fs from "fs/promises";
import { resolveFromCwd, pathExists } from "../util/fs";

export interface DesktopOptions {
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * One of:
   *   - `"dev"`      → emit entry (if missing) and print the Worker-based
   *                    dev pattern. Does NOT auto-launch the window — the
   *                    user runs `bun run src/desktop/main.ts`.
   *   - `"build"`    → emit entry (if missing), run `mandu build`, and
   *                    print the `bun build --compile` recipe.
   *   - `"scaffold"` → emit entry only, no build.
   */
  mode?: "dev" | "build" | "scaffold";
  /** Override the entry path. Default: `src/desktop/main.ts`. */
  entry?: string;
  /** Force overwrite of an existing entry. */
  force?: boolean;
}

/**
 * Minimal main entry emitted by `scaffoldDesktopEntry`. Consumers may
 * customize freely — we only emit when the file doesn't exist (or `force`
 * is set).
 *
 * Exported for tests.
 *
 * @internal
 */
export function _desktopEntryTemplate(): string {
  return `/**
 * Mandu desktop entry
 *
 * Emitted by \`mandu build --target=desktop\`. Boots a Mandu server on
 * 127.0.0.1 with an ephemeral port, then opens a native Webview pointing at
 * it via a Worker (so the blocking Webview event loop doesn't starve the
 * HTTP server).
 *
 * Customize freely. To regenerate the default, delete this file and rerun
 * \`mandu desktop scaffold --force\`.
 */

import { startServer } from "@mandujs/core";
import type { RoutesManifest, BundleManifest } from "@mandujs/core";
import path from "path";
import fs from "fs";

async function loadManifest(): Promise<{
  routes: RoutesManifest;
  bundles?: BundleManifest;
}> {
  const rootDir = path.resolve(import.meta.dir ?? process.cwd(), "..", "..");
  const manifestPath = path.join(rootDir, ".mandu", "manifest.json");
  const routesPath = path.join(rootDir, ".mandu", "routes.json");

  let routes: RoutesManifest;
  try {
    routes = JSON.parse(fs.readFileSync(routesPath, "utf-8")) as RoutesManifest;
  } catch {
    throw new Error(
      "Routes manifest not found. Run \`mandu build\` before launching desktop.",
    );
  }

  let bundles: BundleManifest | undefined;
  try {
    bundles = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as BundleManifest;
  } catch {
    // Pure-SSR projects — bundle manifest is optional.
  }

  return { routes, bundles };
}

async function main(): Promise<void> {
  const { routes, bundles } = await loadManifest();

  const server = startServer(routes, {
    port: 0,
    hostname: "127.0.0.1",
    rootDir: process.cwd(),
    isDev: false,
    bundleManifest: bundles,
  });

  const port = server.server.port;
  const url = \`http://127.0.0.1:\${port}\`;
  console.log(\`[mandu desktop] server listening at \${url}\`);

  // Worker-based window pattern — keeps the blocking Webview loop isolated
  // from Bun.serve(). See: @mandujs/core/desktop/worker.
  const worker = new Worker(
    new URL("@mandujs/core/desktop/worker", import.meta.url),
  );

  worker.addEventListener("message", (ev) => {
    const msg = ev.data as { type?: string; message?: string };
    if (msg?.type === "closed") {
      console.log("[mandu desktop] window closed, shutting down");
      server.stop();
      worker.terminate();
      process.exit(0);
    } else if (msg?.type === "error") {
      console.error("[mandu desktop] worker error:", msg.message);
    }
  });

  worker.postMessage({
    type: "open",
    options: {
      url,
      title: process.env.MANDU_APP_TITLE ?? "Mandu Desktop",
      width: 1280,
      height: 800,
    },
  });
}

main().catch((error) => {
  console.error("[mandu desktop] fatal:", error);
  process.exit(1);
});
`;
}

/**
 * Emit (or verify) the desktop entry file. Returns whether the file was
 * newly written.
 */
export async function scaffoldDesktopEntry(
  options: { cwd: string; entry: string; force: boolean },
): Promise<{ wrote: boolean; path: string }> {
  const entryPath = path.isAbsolute(options.entry)
    ? options.entry
    : path.join(options.cwd, options.entry);

  const exists = await pathExists(entryPath);
  if (exists && !options.force) {
    return { wrote: false, path: entryPath };
  }

  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(entryPath, _desktopEntryTemplate(), "utf-8");
  return { wrote: true, path: entryPath };
}

/**
 * CLI command entry. Wires up `mandu desktop [scaffold|dev|build]` and
 * `mandu build --target=desktop` / `mandu dev --target=desktop`.
 */
export async function desktop(options: DesktopOptions = {}): Promise<boolean> {
  const cwd = options.cwd ?? resolveFromCwd(".");
  const entry = options.entry ?? "src/desktop/main.ts";
  const mode = options.mode ?? "scaffold";

  console.log("🖥️  Mandu Desktop — Phase 9c prototype\n");

  // Preflight: warn when webview-bun peer is absent. Not fatal — the user
  // might be scaffolding ahead of installing.
  const peerMissing = await isPeerMissing(cwd);
  if (peerMissing) {
    console.warn(
      "⚠️  Optional peer 'webview-bun' is not installed. Desktop launch will fail until:",
    );
    console.warn("       bun add webview-bun");
    console.warn("");
  }

  // Always emit the entry (respecting --force).
  const { wrote, path: entryPath } = await scaffoldDesktopEntry({
    cwd,
    entry,
    force: options.force ?? false,
  });
  const relEntry = path.relative(cwd, entryPath);
  if (wrote) {
    console.log(`✅ Wrote desktop entry: ${relEntry}`);
  } else {
    console.log(`ℹ️  Desktop entry already exists: ${relEntry} (use --force to overwrite)`);
  }

  if (mode === "scaffold") {
    console.log("\nNext steps:");
    console.log(`  1. bun add webview-bun`);
    console.log(`  2. mandu build`);
    console.log(`  3. bun run ${relEntry}`);
    return true;
  }

  if (mode === "build") {
    // Run the existing build command first, so the entry's manifest load
    // succeeds. We intentionally call through the public command instead of
    // re-implementing the build pipeline.
    console.log("\n📦 Running mandu build...\n");
    const { build } = await import("./build");
    const built = await build({});
    if (!built) {
      console.error("\n❌ Build failed — aborting desktop packaging.");
      return false;
    }

    // Print the --compile recipe. Phase 9b (B-agent) owns the bundler glue
    // for template embedding; we only surface the command here.
    console.log("\n📦 To package as a single binary:");
    console.log(`     bun build --compile ${relEntry} --outfile mandu-app`);
    console.log("");
    console.log(
      "     (Windows: add --windows-icon / --title / --publisher flags;",
    );
    console.log("      macOS:   code-sign with --sign <identity>;");
    console.log("      Linux:   the produced binary is already portable.)");
    return true;
  }

  // mode === "dev"
  console.log("\n🟢 Desktop dev mode");
  console.log(`   Run the entry directly:`);
  console.log(`     bun run ${relEntry}`);
  console.log("");
  console.log(
    "   (The entry starts a Bun server on 127.0.0.1 with an ephemeral port",
  );
  console.log(
    "    and opens a native Webview window via the core Worker helper.)",
  );
  return true;
}

/**
 * Best-effort check that `webview-bun` is importable from the project
 * directory. We do NOT actually `import()` it here because (a) doing so on
 * a machine without native deps (e.g. Linux without GTK4) would crash the
 * CLI and (b) `mandu desktop scaffold` must work even when the peer is
 * missing — that's the whole point of scaffolding.
 *
 * @internal
 */
export async function isPeerMissing(cwd: string): Promise<boolean> {
  const candidates = [
    path.join(cwd, "node_modules", "webview-bun", "package.json"),
    path.join(cwd, "..", "node_modules", "webview-bun", "package.json"),
    path.join(cwd, "..", "..", "node_modules", "webview-bun", "package.json"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return false;
    }
  }
  return true;
}

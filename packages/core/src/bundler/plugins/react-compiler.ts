/**
 * Bundler plugin — React Compiler (#240).
 *
 * Auto-memoizes React components at build time via the official
 * `babel-plugin-react-compiler`. Runs as a Bun `onLoad` transform:
 * source → Babel + react-compiler → transformed code → Bun's remaining
 * pipeline.
 *
 * Ported inline rather than depending on `bun-plugin-react-compiler`
 * (single-maintainer, 9★ at 2026-04). The substantive logic is ~60
 * lines; keeping it in-repo avoids the supply-chain risk without adding
 * real maintenance cost.
 *
 * ## Scope
 *
 * Only invoked by the bundler's island / `"use client"` / partial build
 * paths. Server-rendered files (`page.tsx` + `layout.tsx` SSR) never
 * hit this plugin because React Compiler's memoization is a re-render
 * optimization; SSR renders once and serializes to HTML. See
 * `bundler/build.ts` for the gate.
 *
 * ## Opt-in
 *
 * Disabled by default. Projects enable via `mandu.config.ts`:
 *
 * ```ts
 * export default {
 *   experimental: {
 *     reactCompiler: { enabled: true },
 *   },
 * } satisfies ManduConfig;
 * ```
 *
 * Failure mode: if `@babel/core` or `babel-plugin-react-compiler` are
 * missing, the plugin returns the original source verbatim and logs
 * once per build. This preserves the "enable the flag → try it" UX
 * without blocking anyone who forgot to install the peer deps.
 */

import type { BunPlugin } from "bun";
import fs from "node:fs/promises";

export interface ReactCompilerPluginOptions {
  /**
   * File filter — only matching paths get the transform. Default:
   * `.jsx` / `.tsx`. The bundler's own client-path gate narrows this
   * further; the regex here is a belt-and-braces check.
   */
  filter?: RegExp;
  /**
   * Options forwarded to `babel-plugin-react-compiler`. Common keys:
   *   - `compilationMode: "annotation" | "infer" | "all"`
   *   - `target: "19" | "18" | "17"`
   *   - `panicThreshold: "none" | "all_errors" | "critical_errors"`
   * Omit to use react-compiler defaults (`compilationMode: "infer"` +
   * `target` derived from the installed `react` version).
   */
  reactCompilerConfig?: Record<string, unknown>;
}

const DEFAULT_FILTER = /\.(?:jsx|tsx)$/;

/**
 * Create the Bun plugin instance. Dynamic imports inside `onLoad` keep
 * `@babel/core` out of the bundler's import graph when the plugin is
 * never activated — the cost is a one-shot `await import()` on first
 * use, which Bun caches.
 */
export function reactCompiler(
  options: ReactCompilerPluginOptions = {},
): BunPlugin {
  const filter = options.filter ?? DEFAULT_FILTER;
  const compilerConfig = options.reactCompilerConfig;

  // `@babel/core` + `babel-plugin-react-compiler` are optional peer
  // dependencies — keep them out of the type graph so projects that
  // don't enable the compiler never need `@types/babel__core`.
  type BabelLike = { transformAsync: (src: string, opts: unknown) => Promise<{ code?: string | null } | null> };
  let babelMod: BabelLike | null = null;
  let compilerPlugin: unknown = null;
  let resolutionFailed = false;

  const resolveBabel = async (): Promise<boolean> => {
    if (resolutionFailed) return false;
    if (babelMod && compilerPlugin) return true;
    try {
      // Both imports are peerDependencies declared `optional: true` so
      // projects without React Compiler never pay the install cost. We
      // import each separately so a missing react-compiler package
      // doesn't mask a Babel install failure.
      if (!babelMod) {
        const mod = (await import(/* @vite-ignore */ "@babel/core" as string)) as unknown as BabelLike;
        babelMod = mod;
      }
      if (!compilerPlugin) {
        const cm = (await import(/* @vite-ignore */ "babel-plugin-react-compiler" as string)) as unknown as {
          default?: unknown;
        };
        compilerPlugin = cm.default ?? cm;
      }
      return true;
    } catch (err) {
      resolutionFailed = true;
      console.warn(
        "[Mandu React Compiler] Peer dependency missing — skipping transform. " +
          "Install @babel/core + babel-plugin-react-compiler to enable. " +
          `Reason: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  return {
    name: "mandu:react-compiler",
    setup(build) {
      build.onLoad({ filter }, async ({ path: filePath }) => {
        const ok = await resolveBabel();
        if (!ok || !babelMod || !compilerPlugin) return undefined;

        let source: string;
        try {
          source = await fs.readFile(filePath, "utf-8");
        } catch {
          // Bun will surface the original read error when it retries
          // the load itself; returning undefined gives it the chance.
          return undefined;
        }

        try {
          const result = await babelMod.transformAsync(source, {
            filename: filePath,
            sourceMaps: "inline",
            babelrc: false,
            configFile: false,
            parserOpts: {
              plugins: [
                "jsx",
                "typescript",
                "explicitResourceManagement",
              ],
            },
            plugins: [[compilerPlugin, compilerConfig ?? {}]],
          });
          if (!result?.code) return undefined;
          return {
            contents: result.code,
            loader: filePath.endsWith(".tsx") ? "tsx" : "jsx",
          };
        } catch (err) {
          // Return original so Bun falls back to its normal transform —
          // react-compiler skips plenty of components by design
          // ("15% bailout") and we don't want a bailout to kill the
          // build. Log once per file path with the reason.
          console.warn(
            `[Mandu React Compiler] skip ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        }
      });
    },
  };
}

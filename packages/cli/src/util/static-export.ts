/**
 * Static export — flatten `.mandu/prerendered/`, `.mandu/client/`, and
 * `public/` into a single directory shaped like the URL space.
 *
 * # Why this exists (Issue #249)
 *
 * `mandu build` writes its outputs into two sibling trees inside `.mandu/`:
 *
 *   - `.mandu/prerendered/`  — per-route HTML (referencing assets by URL)
 *   - `.mandu/client/`       — JS + CSS bundles (served at `/.mandu/client/...`)
 *
 * Static hosts (Vercel, Netlify, Cloudflare Pages, S3+CloudFront, …) accept
 * a single output directory. Pointing `outputDirectory` at `.mandu/prerendered`
 * 404s every asset; pointing at `.mandu` exposes the build dir verbatim. So
 * users had to hand-roll a postbuild script that copies the trees together.
 *
 * `mandu build --static` runs that postbuild step in-tree, producing one
 * directory ready to upload. The on-disk path under `dist/.mandu/client/`
 * is intentional: the prerendered HTML references assets by URL, and those
 * URLs already start with `/.mandu/client/...`. Mirroring the URL space
 * keeps existing pages working without touching emitter code.
 *
 * # Layout
 *
 * ```
 * <outDir>/
 *   index.html                  ← .mandu/prerendered/index.html
 *   <route>/index.html          ← per-locale, per-route prerendered HTML
 *   .mandu/client/...           ← .mandu/client/* (bundles, served at /.mandu/client/...)
 *   <public-files>              ← public/* (served at /<file>)
 * ```
 *
 * # Out of scope
 *
 *   - URL prefix decoupling (see Issue #249 Suggestion 2). Replacing every
 *     hardcoded `/.mandu/client/...` URL across the bundler/server/manifest
 *     with an opaque prefix has a much larger blast radius and does not
 *     block static deploys today. This util keeps the existing URLs and
 *     just materializes the directory layout that matches them.
 *   - SSR/API functions. `--static` is for fully prerenderable sites.
 *     Projects with API routes or non-prerendered pages should keep using
 *     the platform-specific adapters (Workers / Deno / Node SSR).
 *
 * @module cli/util/static-export
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface StaticExportOptions {
  rootDir: string;
  /** Output directory (relative to rootDir or absolute). */
  outDir: string;
  /**
   * When `true`, wipe `outDir` before copying. Default `true` — a stale
   * file mix of an old build and a new build is a worse failure mode than
   * a fresh write.
   */
  clean?: boolean;
}

export interface StaticExportResult {
  /** Resolved absolute output directory. */
  outDir: string;
  /** Total files written into `outDir`. */
  filesCopied: number;
  /**
   * Sub-trees that contributed files. `public` is omitted when no
   * `public/` directory exists; `prerendered` and `client` are required
   * for a static export to be meaningful and trigger a clear error if
   * either is missing.
   */
  copied: {
    prerendered: number;
    client: number;
    public: number;
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dst: string): Promise<number> {
  await fs.mkdir(dst, { recursive: true });
  let count = 0;
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
      count += 1;
    }
    // Symlinks/sockets/etc. are intentionally skipped — `mandu build`
    // never produces them, so encountering one is suspicious. We don't
    // want to silently traverse a symlink that points outside rootDir.
  }
  return count;
}

/**
 * Materialize a static-host-ready directory at `outDir`.
 *
 * Throws when `.mandu/prerendered/` is empty or missing — that means
 * `mandu build` either did not run or produced no static HTML, so a
 * static export would be a hollow tree. Better to fail loud than ship
 * a deploy artifact missing every page.
 */
export async function emitStaticExport(
  options: StaticExportOptions
): Promise<StaticExportResult> {
  const { rootDir, clean = true } = options;
  const outDir = path.isAbsolute(options.outDir)
    ? options.outDir
    : path.resolve(rootDir, options.outDir);

  // Refuse to write into the project root or `.mandu/` itself — those
  // are reserved by the framework and an accidental `--static .` would
  // be ruinous to clean up.
  if (outDir === rootDir || outDir === path.join(rootDir, ".mandu")) {
    throw new Error(
      `mandu build --static: refused to use "${options.outDir}" as the output ` +
        `directory — it overlaps the project root or .mandu/. Pick a dedicated ` +
        `directory like "dist".`
    );
  }

  const prerenderedSrc = path.join(rootDir, ".mandu", "prerendered");
  const clientSrc = path.join(rootDir, ".mandu", "client");
  const publicSrc = path.join(rootDir, "public");

  if (!(await pathExists(prerenderedSrc))) {
    throw new Error(
      `mandu build --static: missing ${path.relative(rootDir, prerenderedSrc)}. ` +
        `Run \`mandu build\` (without --static) first or check that prerender ` +
        `actually produced HTML — a static export with zero pages is not useful.`
    );
  }
  if (!(await pathExists(clientSrc))) {
    throw new Error(
      `mandu build --static: missing ${path.relative(rootDir, clientSrc)}. ` +
        `Client bundles are required so prerendered HTML can resolve its asset ` +
        `URLs. Re-run \`mandu build\` and ensure no errors were reported.`
    );
  }

  if (clean) {
    await fs.rm(outDir, { recursive: true, force: true });
  }
  await fs.mkdir(outDir, { recursive: true });

  // 1) Prerendered HTML at root — these are the URL-shaped pages.
  const prerenderedCopied = await copyDir(prerenderedSrc, outDir);

  // 2) Client bundles preserved under `.mandu/client/` so the absolute
  //    URLs the HTML already references (`/.mandu/client/foo.js`) resolve.
  const clientCopied = await copyDir(
    clientSrc,
    path.join(outDir, ".mandu", "client")
  );

  // 3) User `public/` at the root, if present. Optional — some projects
  //    have nothing to ship beyond prerendered HTML.
  let publicCopied = 0;
  if (await pathExists(publicSrc)) {
    publicCopied = await copyDir(publicSrc, outDir);
  }

  return {
    outDir,
    filesCopied: prerenderedCopied + clientCopied + publicCopied,
    copied: {
      prerendered: prerenderedCopied,
      client: clientCopied,
      public: publicCopied,
    },
  };
}

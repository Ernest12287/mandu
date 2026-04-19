/**
 * Slug Utility (Issue #199)
 *
 * Converts a file path (relative to a collection root) into a stable
 * URL-safe slug. This powers `collection.get(slug)` lookups and the
 * default href generation in `generateSidebar()`.
 *
 * # Algorithm
 *
 *   1. Normalize separators: Windows backslashes → forward slashes so
 *      slugs are portable across platforms
 *   2. Strip the file extension
 *   3. Drop an `index` basename: `docs/intro/index.md` → `docs/intro`
 *      so authors can use index-style directories without a dangling
 *      `/index` suffix in URLs
 *   4. Optional: kebab-case each segment (default ON) so file names
 *      like `Getting_Started.md` produce `getting-started`
 *   5. Remove any consecutive slashes and leading/trailing slashes
 */

/** Options controlling slug generation. */
export interface SlugFromPathOptions {
  /**
   * When true (default), every path segment is lower-cased and
   * underscores/camelCase boundaries are converted to dashes.
   * Disable this when a project's authoring convention requires
   * preserving source file naming — in which case only the
   * extension and `/index` suffix are stripped.
   */
  kebabCase?: boolean;
  /**
   * Extra extensions to strip, in addition to the defaults
   * (`.md`, `.mdx`, `.markdown`). Caller-supplied values should
   * include the leading dot.
   */
  stripExtensions?: string[];
  /**
   * Override the default "drop `/index` suffix" behavior. When
   * false, `foo/index.md` becomes `foo/index` instead of `foo`.
   */
  dropIndex?: boolean;
}

const DEFAULT_EXTS = new Set([".md", ".mdx", ".markdown"]);

/**
 * Convert a collection-relative path to a URL slug.
 *
 * @example
 * ```ts
 * slugFromPath("getting-started/install.md") // "getting-started/install"
 * slugFromPath("Intro\\Welcome.md")          // "intro/welcome"
 * slugFromPath("api/index.md")               // "api"
 * slugFromPath("API_v2.md", { kebabCase: false }) // "API_v2"
 * ```
 */
export function slugFromPath(
  filePath: string,
  options: SlugFromPathOptions = {}
): string {
  const { kebabCase = true, stripExtensions, dropIndex = true } = options;
  const allExts = new Set<string>(DEFAULT_EXTS);
  if (stripExtensions) {
    for (const ext of stripExtensions) allExts.add(ext);
  }

  // Normalize separators first so downstream logic only deals with `/`.
  let out = filePath.replace(/\\/g, "/").trim();

  // Strip any matching extension from the tail. We only strip ONE —
  // files with double extensions (`foo.test.md`) keep the `.test`
  // segment on purpose.
  const dotIdx = out.lastIndexOf(".");
  const slashIdx = out.lastIndexOf("/");
  if (dotIdx > slashIdx) {
    const ext = out.slice(dotIdx);
    if (allExts.has(ext.toLowerCase())) {
      out = out.slice(0, dotIdx);
    }
  }

  // Drop `/index` suffix or a bare `index` basename.
  if (dropIndex) {
    if (out === "index") {
      out = "";
    } else if (out.endsWith("/index")) {
      out = out.slice(0, -"/index".length);
    }
  }

  // kebab-case per segment so existing slashes survive.
  if (kebabCase) {
    out = out
      .split("/")
      .map((seg) =>
        seg
          // Insert dash between camelCase: fooBar → foo-Bar (later lower-cased)
          .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
          .replace(/[_\s]+/g, "-")
          .replace(/--+/g, "-")
          .toLowerCase()
      )
      .join("/");
  }

  // Collapse duplicate slashes and strip boundary slashes.
  out = out.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");

  return out;
}

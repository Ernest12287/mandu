/**
 * Collection API (Issue #199)
 *
 * First-class content collection primitive inspired by Astro's
 * `astro:content` + Next.js `@next/mdx` + Fumadocs. Projects declare
 * collections once in `content.config.ts`, then read them anywhere
 * with full typed autocomplete:
 *
 * ```ts
 * // content.config.ts
 * import { defineCollection, z } from '@mandujs/core/content';
 *
 * export const docs = defineCollection({
 *   path: 'content/docs',
 *   schema: z.object({
 *     title: z.string(),
 *     order: z.number().optional(),
 *     draft: z.boolean().default(false),
 *   }),
 * });
 * ```
 *
 * ```ts
 * // anywhere in the app
 * import { docs } from './content.config';
 *
 * const entries = await docs.all();
 * const intro = await docs.get('intro');
 * ```
 *
 * # Overload compatibility
 *
 * The legacy `defineCollection({ loader, schema })` shape (used by the
 * existing ContentLayer in `content-layer.ts`) is still supported — we
 * detect the shape at runtime and pass config through unchanged. Only
 * the NEW `{ path, schema, ... }` shape returns a `Collection` instance
 * with `.load()/.all()/.get()/.getCompiled()`. This matters because the
 * CLI `mandu collection create` scaffolder already emits the legacy
 * shape, and breaking those projects on a minor version is not an
 * option for the MVP.
 */

import * as fs from "fs";
import * as path from "path";
import type { ZodSchema } from "zod";
import { parseFrontmatter } from "./frontmatter";
import { slugFromPath, type SlugFromPathOptions } from "./slug";

/** A single entry in a Collection after frontmatter + Zod validation. */
export interface CollectionEntry<T = Record<string, unknown>> {
  /** URL-safe slug derived from the file path (see `slugFromPath`). */
  slug: string;
  /** Absolute filesystem path of the source file. */
  filePath: string;
  /** Validated frontmatter data. */
  data: T;
  /** Raw markdown/MDX body (everything after the closing `---`). */
  content: string;
}

/** A compiled MDX entry with a lazy-rendered React component. */
export interface CompiledCollectionEntry<T = Record<string, unknown>>
  extends CollectionEntry<T> {
  /**
   * Rendered component. Falls back to a raw-markdown `<pre>` shell
   * when MDX-compiling tools (`unified`, `remark-*`, `rehype-*`) are
   * not installed — the wrapper always returns SOMETHING so callers
   * don't have to branch on "is MDX tooling present".
   */
  Component: () => unknown;
  /** Rendered HTML string (only populated when MDX tooling is available). */
  html?: string;
}

/**
 * Compare function for sorting `CollectionEntry` instances. Matches the
 * TS `Array.sort` signature so users can compose their own comparators.
 */
export type CollectionSort<T> = (
  a: CollectionEntry<T>,
  b: CollectionEntry<T>
) => number;

/**
 * Options accepted by the MVP `defineCollection({ path, ... })` form.
 */
export interface DefineCollectionOptions<T> {
  /**
   * Directory (relative to the project root, unless absolute) that
   * holds the collection's source files. Glob patterns are NOT
   * supported at the MVP — use one collection per directory. The
   * collection scans this directory recursively for markdown files.
   */
  path: string;
  /**
   * Zod schema for frontmatter validation. When omitted, entries are
   * returned with `data: Record<string, unknown>` and no type safety
   * — useful for prototypes before the shape stabilizes.
   */
  schema?: ZodSchema<T>;
  /**
   * File extensions to include (default: `.md`, `.mdx`, `.markdown`).
   * Caller values should include the leading dot.
   */
  extensions?: string[];
  /**
   * Override slug generation. Receives the collection-relative path
   * (forward slashes) and the parsed frontmatter so authors can force
   * a specific slug via `slug:` in frontmatter, fall back to `title`,
   * etc. Return the resolved slug string.
   */
  slug?: (entry: {
    path: string;
    data: Record<string, unknown>;
  }) => string;
  /**
   * Slug normalization options (forwarded to `slugFromPath`) for the
   * default slug generator. Ignored when a custom `slug` callback is
   * provided.
   */
  slugOptions?: SlugFromPathOptions;
  /**
   * Default sort applied by `.all()`. The framework applies a stable
   * fallback-by-slug tiebreaker on top of whatever the caller returns
   * so repeated loads always yield the same order. When absent, the
   * collection sorts by `data.order` ascending (missing = +Infinity),
   * then by slug alphabetical — matching the `generateSidebar`
   * helper's default.
   */
  sort?: CollectionSort<T>;
  /**
   * Project root override. Normally the Collection resolves `path`
   * against `process.cwd()` lazily at `.load()` time; passing this
   * pins the root for tests or tooling contexts where cwd is unstable.
   */
  root?: string;
}

/** Legacy config shape — preserved to avoid churn on existing projects. */
interface LegacyCollectionConfig {
  loader: unknown;
  schema?: unknown;
}

const DEFAULT_EXTENSIONS = [".md", ".mdx", ".markdown"] as const;

/**
 * Collection instance returned by `defineCollection({ path, ... })`.
 *
 * Load results are cached in-memory after the first `.load()` call.
 * This is intentional — at the MVP we treat collections as build-time
 * data that doesn't change within a process lifetime. Projects that
 * need hot-reload during `mandu dev` will need to call `.invalidate()`
 * explicitly (not yet implemented — tracked as a follow-up).
 */
export class Collection<T = Record<string, unknown>> {
  readonly options: DefineCollectionOptions<T>;
  private entries: CollectionEntry<T>[] | null = null;
  private loadPromise: Promise<CollectionEntry<T>[]> | null = null;

  constructor(options: DefineCollectionOptions<T>) {
    this.options = options;
  }

  /** Resolve the collection root directory. */
  private resolveRoot(): string {
    const root = this.options.root ?? process.cwd();
    if (path.isAbsolute(this.options.path)) return this.options.path;
    return path.resolve(root, this.options.path);
  }

  /**
   * Scan the collection directory, parse frontmatter, validate with
   * the Zod schema, and cache entries. Safe to call repeatedly — the
   * first call's promise is reused by concurrent callers, so a burst
   * of `.all()` / `.get()` calls during initial render won't produce
   * redundant disk I/O.
   */
  async load(): Promise<CollectionEntry<T>[]> {
    if (this.entries) return this.entries;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    try {
      this.entries = await this.loadPromise;
      return this.entries;
    } finally {
      this.loadPromise = null;
    }
  }

  private async doLoad(): Promise<CollectionEntry<T>[]> {
    const root = this.resolveRoot();
    if (!fs.existsSync(root)) {
      // An empty collection is a valid state — authors might scaffold
      // the directory before adding entries. Returning `[]` here lets
      // pages render with "no content yet" messaging instead of 500.
      return [];
    }
    const extensions = this.options.extensions ?? [...DEFAULT_EXTENSIONS];
    const extSet = new Set(extensions.map((e) => e.toLowerCase()));
    const absPaths: string[] = [];
    walkDir(root, absPaths, extSet);

    const entries: CollectionEntry<T>[] = [];
    for (const absPath of absPaths) {
      const relPath = path
        .relative(root, absPath)
        .replace(/\\/g, "/");
      const src = fs.readFileSync(absPath, "utf8");
      let parsed;
      try {
        parsed = parseFrontmatter(src);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[content] failed to parse frontmatter in ${relPath}: ${msg}`
        );
      }
      // Derive slug via the user's override or the built-in kebab-case
      // generator. We pass the parsed frontmatter in so authors can
      // honor a `slug:` field without writing their own loader.
      const rawSlug = this.options.slug
        ? this.options.slug({ path: relPath, data: parsed.data })
        : typeof parsed.data.slug === "string" && parsed.data.slug.length > 0
          ? String(parsed.data.slug)
          : slugFromPath(relPath, this.options.slugOptions);

      let data = parsed.data as unknown as T;
      if (this.options.schema) {
        const result = this.options.schema.safeParse(parsed.data);
        if (!result.success) {
          throw new Error(
            `[content] schema validation failed for ${relPath}: ${formatZodError(
              result.error
            )}`
          );
        }
        data = result.data;
      }
      entries.push({
        slug: rawSlug,
        filePath: absPath,
        data,
        content: parsed.body,
      });
    }

    const sorter = this.options.sort ?? defaultSort<T>();
    // Stable sort by applying a slug tiebreaker AFTER the user sort.
    // Node's Array.sort is stable as of V8 7.0+ (Bun uses V8), but we
    // prefer not to rely on user comparators returning 0 for
    // equivalent entries, so we fold the tiebreaker into the key.
    entries.sort((a, b) => {
      const primary = sorter(a, b);
      if (primary !== 0) return primary;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    return entries;
  }

  /** Return all entries (cached). */
  async all(): Promise<CollectionEntry<T>[]> {
    return this.load();
  }

  /** Retrieve a single entry by slug, or undefined. */
  async get(slug: string): Promise<CollectionEntry<T> | undefined> {
    const entries = await this.load();
    return entries.find((e) => e.slug === slug);
  }

  /**
   * Return an entry with a lazy-rendered React component.
   *
   * When optional MDX tooling (`unified`, `remark-parse`, `remark-rehype`,
   * `rehype-stringify`) is present in the user's deps, we pipe the body
   * through it and return both the raw HTML and a React component that
   * renders via `dangerouslySetInnerHTML` (safe because the source is
   * build-time content the project controls). When tooling is absent,
   * `Component` still returns a valid React element — a `<pre>` wrapper
   * around the raw markdown — so callers never have to branch on the
   * missing-dep case.
   */
  async getCompiled(
    slug: string
  ): Promise<CompiledCollectionEntry<T> | undefined> {
    const entry = await this.get(slug);
    if (!entry) return undefined;
    const rendered = await renderMarkdownSafe(entry.content);
    return {
      ...entry,
      html: rendered.html,
      Component: rendered.Component,
    };
  }

  /**
   * Reset the in-memory cache so the next `.load()` rescans disk.
   * Used by tests and (eventually) the dev-mode file watcher.
   */
  invalidate(): void {
    this.entries = null;
  }
}

/**
 * Default comparator: `data.order` ascending, with missing order
 * treated as infinity so numbered entries sink to the top.
 */
function defaultSort<T>(): CollectionSort<T> {
  return (a, b) => {
    const oa = (a.data as { order?: unknown })?.order;
    const ob = (b.data as { order?: unknown })?.order;
    const na = typeof oa === "number" ? oa : Number.POSITIVE_INFINITY;
    const nb = typeof ob === "number" ? ob : Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    return 0;
  };
}

/**
 * Compact a Zod error into a single line suitable for the error
 * messages surfaced by `Collection.load()`. We deliberately avoid
 * `z.prettifyError` (not present in Zod 3) and the flattener —
 * `issue.path` + `issue.message` is enough for docs authors to
 * locate the broken field fast.
 */
function formatZodError(error: {
  issues: Array<{ path: (string | number)[]; message: string }>;
}): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Synchronous recursive directory walker — the collection typically
 * has a bounded number of entries (dozens to low thousands) so the
 * sync cost is negligible, and using sync simplifies error paths
 * and the cache-hit fast-path in `load()`.
 */
function walkDir(dir: string, out: string[], extSet: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(absPath, out, extSet);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!extSet.has(ext)) continue;
    out.push(absPath);
  }
}

/**
 * Lazy markdown renderer. Attempts to load `unified` + the standard
 * remark/rehype plugin chain; when any piece is missing, falls back
 * to returning a `<pre>` shell so the caller gets a stable API.
 *
 * We go through `Function("return import(...)")` instead of a direct
 * dynamic `import()` so TS doesn't resolve the optional modules
 * during typecheck — they are NOT in `@mandujs/core` deps by design.
 */
async function renderMarkdownSafe(
  body: string
): Promise<{ html?: string; Component: () => unknown }> {
  // Passing the module specifier through a Function-wrapped dynamic
  // import keeps TypeScript from erroring on optional peer deps; if
  // any module is missing we fall through to the raw-markdown path.
  const tryImport = async (id: string): Promise<unknown> => {
    try {
      return await (Function("x", "return import(x)") as (x: string) => Promise<unknown>)(id);
    } catch {
      return null;
    }
  };
  const unified = (await tryImport("unified")) as
    | { unified: () => unknown }
    | null;
  const remarkParse = (await tryImport("remark-parse")) as
    | { default: unknown }
    | null;
  const remarkRehype = (await tryImport("remark-rehype")) as
    | { default: unknown }
    | null;
  const rehypeStringify = (await tryImport("rehype-stringify")) as
    | { default: unknown }
    | null;

  if (unified && remarkParse && remarkRehype && rehypeStringify) {
    try {
      type Processor = {
        use: (plugin: unknown) => Processor;
        process: (src: string) => Promise<{ toString: () => string }>;
      };
      // Type-punned unified chain — optional peer deps don't carry
      // their own types into our graph, so we route through `unknown`.
      const chain = unified.unified() as unknown as Processor;
      const file = await chain
        .use(remarkParse.default)
        .use(remarkRehype.default)
        .use(rehypeStringify.default)
        .process(body);
      const html = file.toString();
      return {
        html,
        Component: () => createHtmlElement(html),
      };
    } catch {
      // Fall through to raw fallback
    }
  }

  // Fallback: emit a simple React element wrapping the raw body in a
  // `<pre>` so pages don't 500. Pages that need real MDX should
  // install `unified` + remark/rehype in their project.
  return {
    Component: () => createPreElement(body),
  };
}

/**
 * Build a lightweight React element carrying HTML content. We avoid
 * importing React directly so `@mandujs/core/content` stays
 * React-free at import time — the returned value is the plain React
 * element shape (`{ type, props, key }`) which matches what
 * `React.createElement('div', { dangerouslySetInnerHTML: ... })`
 * produces. If the project hosts a React version that uses a
 * different shape, users can swap to their own compiler.
 */
function createHtmlElement(html: string): unknown {
  return {
    type: "div",
    props: {
      dangerouslySetInnerHTML: { __html: html },
    },
    key: null,
    // React 19 uses a $$typeof symbol to distinguish elements —
    // stamp it so React.isValidElement() accepts us.
    $$typeof: Symbol.for("react.element"),
    ref: null,
  };
}

function createPreElement(body: string): unknown {
  return {
    type: "pre",
    props: { children: body },
    key: null,
    $$typeof: Symbol.for("react.element"),
    ref: null,
  };
}

// ---------------------------------------------------------------------------
// defineCollection overloads
// ---------------------------------------------------------------------------

/**
 * Legacy signature — pass-through for projects using the existing
 * ContentLayer (`{ loader, schema }`). We detect the shape at runtime
 * and return the config unchanged so downstream
 * `defineContentConfig({ collections: { ... } })` keeps working.
 */
export function defineCollection<T extends LegacyCollectionConfig>(
  config: T
): T;

/**
 * MVP signature — create a typed `Collection` from a directory path
 * and optional Zod schema.
 */
export function defineCollection<T>(
  options: DefineCollectionOptions<T>
): Collection<T>;

export function defineCollection(
  config: LegacyCollectionConfig | DefineCollectionOptions<unknown>
): unknown {
  // Disambiguate by the presence of a `loader` property — the legacy
  // config always has one, the MVP config never does. Passing both
  // throws so the error points to the conflict rather than letting
  // one branch silently win.
  if (isLegacyConfig(config)) {
    if ("path" in config) {
      throw new Error(
        "[defineCollection] config has both `loader` and `path`; pick one — the legacy ContentLayer uses `loader`, the MVP Collection API uses `path`."
      );
    }
    return config;
  }
  return new Collection(config as DefineCollectionOptions<unknown>);
}

function isLegacyConfig(
  cfg: LegacyCollectionConfig | DefineCollectionOptions<unknown>
): cfg is LegacyCollectionConfig {
  return typeof cfg === "object" && cfg !== null && "loader" in cfg;
}

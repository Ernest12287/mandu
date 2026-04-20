/**
 * Sidebar Generator (Issues #199, #205)
 *
 * Takes a loaded `Collection` and produces a nested navigation tree
 * suitable for rendering a docs sidebar.
 *
 * Two output shapes are supported:
 *
 *   1. **`SidebarNode[]`** (default) — a lightweight
 *      `{ title, href, children }` tree. Backward-compatible with the
 *      Wave D MVP signature: `await generateSidebar(collection)`.
 *
 *   2. **`Category[]`** (Issue #205) — a richer tree with `slug`,
 *      `icon`, `order`, and `items` so docs sites can render
 *      sectioned navigation with icons and explicit ordering. Enable
 *      via `generateCategoryTree(collection, options)`.
 *
 * # `_meta.json` support (Issue #205)
 *
 * When a directory contains a `_meta.json` file alongside its
 * markdown entries, the generator reads it for per-directory metadata
 * and ordering hints:
 *
 *   ```json
 *   {
 *     "title": "Getting Started",
 *     "icon": "rocket",
 *     "order": 1,
 *     "pages": ["intro", "install", "quickstart"]
 *   }
 *   ```
 *
 * The `pages` field takes precedence over frontmatter `order` and
 * filename alphabetical — it is the explicit escape hatch when the
 * author wants a specific nav order that does not match any
 * mechanical rule. Missing `pages` entries fall back to frontmatter
 * `order` ascending, then filename alphabetical (numeric-aware so
 * `10-foo` sorts after `2-foo`).
 *
 * # Ordering precedence (siblings at the same depth)
 *
 *   1. Explicit index in parent's `_meta.json` `pages: []`.
 *   2. `order` field — directory `_meta.json` for categories,
 *      frontmatter `order` for leaf entries. Lower values first.
 *   3. Numeric-aware filename comparison (title or slug).
 *
 * # Draft entries
 *
 * Entries with `data.draft === true` are **filtered out by default**.
 * Callers can surface them with `includeDrafts: true` (preview builds).
 */

import * as fs from "fs";
import * as path from "path";
import type { Collection, CollectionEntry } from "./collection";
export type { Collection };

/** A node in the sidebar tree (legacy + MVP shape). */
export interface SidebarNode {
  title: string;
  href: string;
  /** Present only on branch nodes (grouped categories). */
  children?: SidebarNode[];
  /** Draft/external flags — populated by the generator, caller-facing. */
  draft?: boolean;
}

/**
 * Rich category node produced by `generateCategoryTree` (Issue #205).
 * `items` mixes child categories and leaf entries — siblings at any
 * depth are ordered consistently under the same precedence rules.
 */
export interface Category {
  /** Directory-relative slug. For nested categories this includes
   *  parent slugs (`getting-started/install`). For the root-level
   *  synthetic category, this is `""`. */
  slug: string;
  /** Resolved title — `_meta.json.title` > directory name > slug. */
  title: string;
  /** Optional icon identifier from `_meta.json.icon`. */
  icon?: string;
  /** Ordering key (`_meta.json.order`). Missing = Infinity. */
  order?: number;
  /** Mixed children: `Category` branches or leaf `CategoryEntry`s. */
  items: Array<Category | CategoryEntry>;
  /** Absolute href for the category landing, when an `index` entry exists. */
  href?: string;
  /** Tag so callers can discriminate without `'items' in x`. */
  kind: "category";
}

/** Leaf entry emitted into a `Category.items` array. */
export interface CategoryEntry {
  /** Absolute href (prefixed by `basePath`). */
  href: string;
  /** Resolved title — frontmatter `title` > slug. */
  title: string;
  /** Optional per-entry icon from frontmatter. */
  icon?: string;
  /** Frontmatter `order`, when present. */
  order?: number;
  /** The original slug (directory-relative). */
  slug: string;
  /** `data.draft === true` — surfaced only when `includeDrafts` is on. */
  draft?: boolean;
  /** Tag so callers can discriminate without `'items' in x`. */
  kind: "entry";
}

/** Shape of a `_meta.json` file as parsed by the sidebar generator. */
export interface DirMeta {
  /** Override for the category title. */
  title?: string;
  /** Icon identifier (consumer-defined, e.g. a lucide name). */
  icon?: string;
  /** Ordering key among siblings — ascending. */
  order?: number;
  /**
   * Explicit list of child slugs (directory-relative, extension-free)
   * that controls the order and membership of `items`. Entries not
   * listed here are appended in the default order after the listed
   * entries — authors get a "pin these at top" ergonomic without
   * having to list every file.
   */
  pages?: string[];
}

/** Options controlling sidebar shape and filtering. */
export interface GenerateSidebarOptions<T> {
  /**
   * Href prefix prepended to every node. Defaults to `/` so a slug
   * of `intro` becomes `/intro`. Projects mounting docs under
   * `/docs/` should pass `basePath: '/docs'`.
   */
  basePath?: string;
  /**
   * Extract the title shown in the sidebar. Defaults to
   * `entry.data.title ?? entry.slug`. Implementations that store
   * the sidebar label in a different field (e.g. `nav_title`) can
   * override here.
   */
  getTitle?: (entry: CollectionEntry<T>) => string;
  /**
   * When true, include entries with `data.draft === true`. Defaults
   * to false so production builds never leak unpublished pages into
   * the nav.
   */
  includeDrafts?: boolean;
  /**
   * Custom comparator applied to siblings at every level. When
   * omitted, the default (order-then-title) comparator is used —
   * consistent with `Collection.all()`'s default sort so the
   * sidebar order matches the `.all()` order.
   */
  sortNodes?: (a: SidebarNode, b: SidebarNode, depth: number) => number;
  /**
   * When a directory has no own "index" entry, synthesize a branch
   * node from the directory name. Default: true. Disable when a
   * project prefers flat nav with all leaves at root.
   */
  synthesizeGroups?: boolean;
  /**
   * When true, read `_meta.json` from each directory for titles,
   * icons, explicit `pages` ordering, and numeric `order`. Default:
   * true. Set to false for projects that don't use the convention —
   * the generator gracefully skips missing files regardless, so
   * disabling is purely a performance knob for very large trees.
   */
  useDirMeta?: boolean;
}

interface InternalNode {
  title: string;
  href: string;
  order: number;
  draft: boolean;
  slugSegments: string[];
  children: Map<string, InternalNode>;
  /** Source entry if this node corresponds to a real file. */
  entry?: CollectionEntry<unknown>;
  /** Directory-level metadata (from `_meta.json`, when present). */
  dirMeta?: DirMeta;
  /** Icon resolved from dir meta OR entry frontmatter. */
  icon?: string;
}

/**
 * Build a sidebar tree from a collection. Awaits `collection.all()`
 * internally so callers don't need to load beforehand.
 */
export async function generateSidebar<T>(
  collection: Collection<T>,
  options: GenerateSidebarOptions<T> = {}
): Promise<SidebarNode[]> {
  const {
    basePath = "/",
    getTitle,
    includeDrafts = false,
    sortNodes,
    synthesizeGroups = true,
    useDirMeta = true,
  } = options;
  const entries = await collection.all();
  const visible = includeDrafts
    ? entries
    : entries.filter((e) => !(e.data as { draft?: unknown })?.draft);

  const root = new Map<string, InternalNode>();
  for (const entry of visible) {
    insertEntry(root, entry, getTitle, basePath, synthesizeGroups);
  }

  // Apply `_meta.json` metadata to the tree — only when the caller
  // opts in (default) AND the collection has a resolvable root.
  // Missing directories are a no-op so this is safe for synthetic
  // or virtual collections.
  if (useDirMeta) {
    const collectionRoot = resolveCollectionRoot(collection);
    if (collectionRoot) {
      applyDirMeta(root, collectionRoot, []);
    }
  }

  const tree = toSidebarNodes(root, basePath, synthesizeGroups);
  sortTreeWithMeta(tree, root, 0, sortNodes);
  return tree;
}

/**
 * Build a `Category[]` tree with rich metadata (slug, icon, order,
 * items). The `Category` shape is the preferred output for new docs
 * sites — legacy callers can keep using `generateSidebar`.
 *
 * Uses the same `_meta.json` conventions as `generateSidebar`. The
 * synthetic root category is flattened — the return value is the
 * array of top-level categories / entries, not a single wrapping
 * root (consistent with how `generateSidebar` returns `SidebarNode[]`).
 */
export async function generateCategoryTree<T>(
  collection: Collection<T>,
  options: GenerateSidebarOptions<T> = {}
): Promise<Array<Category | CategoryEntry>> {
  const {
    basePath = "/",
    getTitle,
    includeDrafts = false,
    synthesizeGroups = true,
    useDirMeta = true,
  } = options;
  const entries = await collection.all();
  const visible = includeDrafts
    ? entries
    : entries.filter((e) => !(e.data as { draft?: unknown })?.draft);

  const root = new Map<string, InternalNode>();
  for (const entry of visible) {
    insertEntry(root, entry, getTitle, basePath, synthesizeGroups);
  }
  if (useDirMeta) {
    const collectionRoot = resolveCollectionRoot(collection);
    if (collectionRoot) {
      applyDirMeta(root, collectionRoot, []);
    }
  }

  return buildCategoryArray(root, []);
}

function insertEntry<T>(
  root: Map<string, InternalNode>,
  entry: CollectionEntry<T>,
  getTitle: ((entry: CollectionEntry<T>) => string) | undefined,
  basePath: string,
  synthesizeGroups: boolean
): void {
  const segments = entry.slug === "" ? [""] : entry.slug.split("/");
  let cursor = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLeaf = i === segments.length - 1;
    let node = cursor.get(seg);
    if (!node) {
      node = {
        title: seg || "index",
        href: joinHref(basePath, segments.slice(0, i + 1).join("/")),
        order: Number.POSITIVE_INFINITY,
        draft: false,
        slugSegments: segments.slice(0, i + 1),
        children: new Map(),
      };
      cursor.set(seg, node);
    }
    if (isLeaf) {
      // Attach entry data to this node — overrides synthesized title.
      node.entry = entry as CollectionEntry<unknown>;
      node.title = getTitle
        ? getTitle(entry)
        : typeof (entry.data as { title?: unknown })?.title === "string"
          ? String((entry.data as { title: string }).title)
          : entry.slug || "index";
      const rawOrder = (entry.data as { order?: unknown })?.order;
      if (typeof rawOrder === "number") node.order = rawOrder;
      node.draft = Boolean((entry.data as { draft?: unknown })?.draft);
      const rawIcon = (entry.data as { icon?: unknown })?.icon;
      if (typeof rawIcon === "string") node.icon = rawIcon;
      node.href = joinHref(basePath, entry.slug);
    } else if (!synthesizeGroups) {
      // When groups are disabled, promote deeply-nested leaves to
      // flat root entries. We still traverse for consistent sorting.
      cursor = node.children;
      continue;
    }
    cursor = node.children;
  }
}

function toSidebarNodes(
  map: Map<string, InternalNode>,
  _basePath: string,
  _synthesizeGroups: boolean
): SidebarNode[] {
  const out: SidebarNode[] = [];
  for (const [key, node] of map) {
    // `__dir__` is a synthetic meta-only key created by
    // `applyDirMeta` — never emit it as a real sidebar node.
    if (key === "__dir__") continue;
    const children =
      node.children.size > 0
        ? toSidebarNodes(node.children, _basePath, _synthesizeGroups)
        : undefined;
    const sidebarNode: SidebarNode = {
      title: node.title,
      href: node.href,
    };
    if (node.draft) sidebarNode.draft = true;
    if (children) sidebarNode.children = children;
    out.push(sidebarNode);
  }
  return out;
}

/**
 * Sort the sidebar tree using the internal metadata (dir meta's
 * `pages` / `order` and leaf `order`). We route through the
 * InternalNode map to access `pages` ordering, then fall back to
 * the public `sortNodes` comparator for anything left over.
 */
function sortTreeWithMeta(
  nodes: SidebarNode[],
  internalMap: Map<string, InternalNode>,
  depth: number,
  custom: ((a: SidebarNode, b: SidebarNode, depth: number) => number) | undefined
): void {
  // Build an index from SidebarNode.href -> InternalNode so we can
  // resolve meta for each public node without another pass.
  const byHref = new Map<string, InternalNode>();
  for (const node of internalMap.values()) {
    byHref.set(node.href, node);
  }

  // `pages` list from the parent dir meta — precomputed by the
  // caller when we recurse into a specific subtree. At the top
  // level we look at the root-level `_meta.json` (stored under the
  // synthetic `""` key when present).
  const rootMeta = internalMap.get("__dir__")?.dirMeta;
  const explicitPages = rootMeta?.pages ?? [];
  const pagesIndex = new Map<string, number>();
  explicitPages.forEach((slug, idx) => {
    // `pages` entries are relative slugs (just the last segment).
    pagesIndex.set(slug, idx);
  });

  const fallbackNumeric = (a: SidebarNode, b: SidebarNode): number =>
    a.title.localeCompare(b.title, undefined, { numeric: true });

  nodes.sort((a, b) => {
    const aInternal = byHref.get(a.href);
    const bInternal = byHref.get(b.href);

    // 1. Explicit `pages` position wins absolutely.
    const aLastSeg = lastSlugSegment(aInternal);
    const bLastSeg = lastSlugSegment(bInternal);
    const aIdx = aLastSeg !== undefined ? pagesIndex.get(aLastSeg) : undefined;
    const bIdx = bLastSeg !== undefined ? pagesIndex.get(bLastSeg) : undefined;
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;

    // 2. Caller-supplied comparator.
    if (custom) {
      const c = custom(a, b, depth);
      if (c !== 0) return c;
    }

    // 3. Numeric `order` from frontmatter / dir meta.
    const aOrder = categoryOrder(aInternal);
    const bOrder = categoryOrder(bInternal);
    if (aOrder !== bOrder) return aOrder - bOrder;

    // 4. Numeric-aware title collation.
    return fallbackNumeric(a, b);
  });

  for (const node of nodes) {
    if (node.children) {
      // Recurse into the child InternalNode map so nested pages/order
      // metadata applies at each level.
      const internal = byHref.get(node.href);
      if (internal) {
        const childrenMap = internal.children;
        // Seed the child map's `__dir__` proxy with the parent's
        // dir meta for recursion — we previously stored dir meta on
        // the parent node itself.
        if (internal.dirMeta) {
          childrenMap.set("__dir__", {
            ...internal,
            dirMeta: internal.dirMeta,
            children: new Map(),
          });
        }
        sortTreeWithMeta(node.children, childrenMap, depth + 1, custom);
        childrenMap.delete("__dir__");
      } else {
        node.children.sort(fallbackNumeric);
        for (const child of node.children) {
          if (child.children) sortTreeWithMeta(child.children, new Map(), depth + 1, custom);
        }
      }
    }
  }
}

function lastSlugSegment(node: InternalNode | undefined): string | undefined {
  if (!node) return undefined;
  return node.slugSegments[node.slugSegments.length - 1];
}

function categoryOrder(node: InternalNode | undefined): number {
  if (!node) return Number.POSITIVE_INFINITY;
  if (typeof node.dirMeta?.order === "number") return node.dirMeta.order;
  return node.order;
}

function joinHref(base: string, slug: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!slug) return normalizedBase || "/";
  const normalizedSlug = slug.startsWith("/") ? slug.slice(1) : slug;
  return `${normalizedBase}/${normalizedSlug}`.replace(/\/+/g, "/");
}

/**
 * Resolve the filesystem root for a collection without reaching into
 * its private state. We rely on the public `options.path` + optional
 * `options.root` to recreate the path; if either is missing (e.g. a
 * synthetic collection built from `new Collection({ path: "" })`),
 * we return `null` and skip dir-meta loading.
 */
function resolveCollectionRoot<T>(collection: Collection<T>): string | null {
  const opts = collection.options;
  if (!opts.path) return null;
  const root = opts.root ?? process.cwd();
  const resolved = path.isAbsolute(opts.path)
    ? opts.path
    : path.resolve(root, opts.path);
  // Skip dir-meta entirely if the directory doesn't exist on disk —
  // synthetic collections shouldn't crash on first load.
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

/**
 * Walk the internal tree, loading `_meta.json` at each directory
 * level when present. Non-existent files are silently skipped;
 * malformed JSON emits a one-line warning (so authors can diagnose
 * typos) and continues with empty meta.
 */
function applyDirMeta(
  map: Map<string, InternalNode>,
  currentDir: string,
  pathSoFar: string[]
): void {
  // Look for a `_meta.json` at this directory level and attach it
  // to every child node so sorting/category generation can consult
  // the parent's metadata.
  const metaPath = path.join(currentDir, "_meta.json");
  let dirMeta: DirMeta | undefined;
  if (fs.existsSync(metaPath)) {
    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      dirMeta = JSON.parse(raw) as DirMeta;
    } catch (err) {
      // A broken `_meta.json` should not crash the sidebar —
      // authors will see the warning and fix it. We fall back to
      // the same defaults as if the file were absent.
      console.warn(
        `[content] failed to parse ${metaPath}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Attach the dir meta to each node at this level so sorting /
  // category generation can pick it up. A `_meta.json` in docs/
  // describes its children — so we stash it under the SYNTHETIC
  // `__dir__` key of the parent map, which `sortTreeWithMeta` and
  // `buildCategoryArray` both look up.
  if (dirMeta) {
    // Pin the parent's dir meta onto the map itself via the
    // `__dir__` synthetic key. The key never collides with a
    // real slug segment because slug segments are URL-safe and
    // never start with `__`.
    map.set("__dir__", {
      title: dirMeta.title ?? path.basename(currentDir) ?? "",
      href: "",
      order: typeof dirMeta.order === "number" ? dirMeta.order : Number.POSITIVE_INFINITY,
      draft: false,
      slugSegments: pathSoFar,
      children: new Map(),
      dirMeta,
      icon: dirMeta.icon,
    });
  }

  // Recurse into every child directory.
  for (const [seg, node] of map) {
    if (seg === "__dir__") continue;
    // A child is a directory iff it has children OR the segment
    // maps to an actual directory on disk (the node may be a file
    // entry with no children but a dir-level sibling).
    const childDir = path.join(currentDir, seg);
    if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
      // Copy parent's dir meta's icon/order onto this branch
      // node so category output has the right values even if the
      // child directory has no _meta.json of its own.
      if (dirMeta) {
        // Record on the branch itself when it's a grouping
        // category (has children).
        if (node.children.size > 0) {
          // No-op: we'll fetch dir meta for this branch from its
          // own _meta.json during recursion.
        }
      }
      applyDirMeta(node.children, childDir, [...pathSoFar, seg]);
    }
  }
}

/**
 * Build the `Category | CategoryEntry` array from the internal
 * tree. Siblings at each depth are sorted under the same precedence
 * as `sortTreeWithMeta`: explicit `pages` > `order` > numeric title.
 */
function buildCategoryArray(
  map: Map<string, InternalNode>,
  pathSoFar: string[]
): Array<Category | CategoryEntry> {
  const dirMetaNode = map.get("__dir__");
  const dirMeta = dirMetaNode?.dirMeta;
  const pagesIndex = new Map<string, number>();
  if (dirMeta?.pages) {
    dirMeta.pages.forEach((slug, idx) => pagesIndex.set(slug, idx));
  }

  const out: Array<Category | CategoryEntry> = [];
  for (const [seg, node] of map) {
    if (seg === "__dir__") continue;
    const segmentSlug = pathSoFar.concat(seg).join("/");
    if (node.children.size > 0) {
      // Branch — emit a Category.
      const childDirMetaNode = node.children.get("__dir__");
      const childDirMeta = childDirMetaNode?.dirMeta;
      const category: Category = {
        kind: "category",
        slug: segmentSlug,
        title:
          childDirMeta?.title ??
          (node.entry
            ? node.title
            : seg || "index"),
        items: buildCategoryArray(node.children, pathSoFar.concat(seg)),
      };
      if (typeof childDirMeta?.order === "number") {
        category.order = childDirMeta.order;
      } else if (node.order !== Number.POSITIVE_INFINITY) {
        category.order = node.order;
      }
      if (childDirMeta?.icon) category.icon = childDirMeta.icon;
      else if (node.icon) category.icon = node.icon;
      // If the branch has an entry attached (e.g. `docs/guide.md`
      // AND `docs/guide/` both exist), expose the href so the
      // category can also be clickable.
      if (node.entry) category.href = node.href;
      out.push(category);
    } else {
      // Leaf — emit a CategoryEntry.
      const entry: CategoryEntry = {
        kind: "entry",
        slug: segmentSlug,
        title: node.title,
        href: node.href,
      };
      if (node.order !== Number.POSITIVE_INFINITY) entry.order = node.order;
      if (node.icon) entry.icon = node.icon;
      if (node.draft) entry.draft = true;
      out.push(entry);
    }
  }

  out.sort((a, b) => {
    const aKey = categorySlugSegment(a);
    const bKey = categorySlugSegment(b);
    const aIdx = pagesIndex.get(aKey);
    const bIdx = pagesIndex.get(bKey);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;

    const aOrder = a.order ?? Number.POSITIVE_INFINITY;
    const bOrder = b.order ?? Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.title.localeCompare(b.title, undefined, { numeric: true });
  });

  return out;
}

function categorySlugSegment(node: Category | CategoryEntry): string {
  const parts = node.slug.split("/");
  return parts[parts.length - 1] ?? node.slug;
}

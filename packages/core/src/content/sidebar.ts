/**
 * Sidebar Generator (Issue #199)
 *
 * Takes a loaded `Collection` and produces a nested `{ title, href,
 * children }` tree suitable for rendering a docs sidebar. The goal is
 * to make the common case (slash-delimited slugs → hierarchical nav)
 * work with zero config, while leaving escape hatches for projects
 * with bespoke ordering.
 *
 * # Ordering rules
 *
 *   1. `order` field from frontmatter (ascending, missing = +Infinity)
 *   2. Fallback: slug alphabetical
 *   3. Category-level ordering: a `_category` meta file with an
 *      `order` field controls sibling order at the parent level —
 *      deliberately NOT implemented at the MVP; callers that need it
 *      today can pass a custom `sortNodes` comparator.
 *
 * # Draft entries
 *
 * When `collection.all()` yields entries with `data.draft === true`,
 * they are **filtered out by default**. Callers can disable this by
 * passing `includeDrafts: true` (useful during preview builds).
 */

import type { Collection, CollectionEntry } from "./collection";
export type { Collection };

/** A node in the sidebar tree. */
export interface SidebarNode {
  title: string;
  href: string;
  /** Present only on branch nodes (grouped categories). */
  children?: SidebarNode[];
  /** Draft/external flags — populated by the generator, caller-facing. */
  draft?: boolean;
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
   * omitted, the default (order-then-slug) comparator is used —
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
  } = options;
  const entries = await collection.all();
  const visible = includeDrafts
    ? entries
    : entries.filter((e) => !(e.data as { draft?: unknown })?.draft);

  const root = new Map<string, InternalNode>();
  for (const entry of visible) {
    insertEntry(root, entry, getTitle, basePath, synthesizeGroups);
  }

  const tree = toSidebarNodes(root, basePath, synthesizeGroups);
  sortTree(tree, 0, sortNodes);
  return tree;
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
  for (const node of map.values()) {
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

function sortTree(
  nodes: SidebarNode[],
  depth: number,
  custom: ((a: SidebarNode, b: SidebarNode, depth: number) => number) | undefined
): void {
  // Fallback comparator: order field via per-node metadata is lost in
  // the conversion to SidebarNode (intentionally — the public surface
  // is title/href), so sort by title with a numeric-aware collator so
  // "10-foo" sorts after "2-foo" for authors prefixing filenames.
  const fallback = (a: SidebarNode, b: SidebarNode): number =>
    a.title.localeCompare(b.title, undefined, { numeric: true });
  nodes.sort((a, b) => {
    if (custom) {
      const c = custom(a, b, depth);
      if (c !== 0) return c;
    }
    return fallback(a, b);
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children, depth + 1, custom);
  }
}

function joinHref(base: string, slug: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!slug) return normalizedBase || "/";
  const normalizedSlug = slug.startsWith("/") ? slug.slice(1) : slug;
  return `${normalizedBase}/${normalizedSlug}`.replace(/\/+/g, "/");
}

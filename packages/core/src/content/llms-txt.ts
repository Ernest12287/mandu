/**
 * llms.txt Generator (Issue #199)
 *
 * Emits a single plain-text index of collection entries in the
 * `llms.txt` convention (https://llmstxt.org). The output is a
 * deterministic Markdown-ish digest that LLM ingestion pipelines can
 * crawl without having to understand the project's routing or MDX
 * compilation.
 *
 * # Default format
 *
 * ```text
 * # {site.name}
 *
 * ## docs
 * - [Introduction](/docs/intro): Getting started
 * - [CLI](/docs/cli): Command reference
 *
 * ## blog
 * - [Hello world](/blog/hello): First post
 * ```
 *
 * # `full: true` variant
 *
 * When `full: true` is passed, every entry's body is inlined after
 * its heading — useful for tools that want an offline snapshot of
 * all content. This produces `llms-full.txt` in most conventions;
 * the filename is the caller's responsibility.
 */

import type { Collection, CollectionEntry } from "./collection";

/**
 * Collection shape accepted by llms.txt — we use a structural subset
 * (just the `all()` method) so callers can pass typed collections
 * (`Collection<{ title: string }>`) without fighting TypeScript's
 * invariance on generic classes. The generator never writes back into
 * the collection, so the type-erasure to `CollectionEntry<unknown>`
 * is safe at runtime — llms.txt reads `data.title`/`data.description`
 * via `unknown` narrowing.
 */
// Covariant read-only view of a Collection. We deliberately re-declare
// the method signature with `unknown` so Collection<{...}> assigns
// structurally. `bivarianceHack` lets the assignability flow.
interface CollectionReader {
  all(): Promise<Array<{ slug: string; filePath: string; data: unknown; content: string }>>;
}

/** Entry in the input array — either a Collection or a pre-loaded triple. */
export type LLMSTxtInput =
  | { name: string; collection: CollectionReader }
  | { name: string; entries: CollectionEntry<unknown>[] };

// Re-export the full Collection type so consumers importing the llms
// types still see the concrete class alongside the reader alias.
export type { Collection };

/** Options controlling llms.txt rendering. */
export interface GenerateLLMSTxtOptions {
  /**
   * Top-level site title. Rendered as the `#` heading. When omitted,
   * the heading line is skipped so callers can prepend their own.
   */
  siteName?: string;
  /**
   * Short description rendered below the site heading. Ignored
   * when `siteName` is omitted — the heading anchors the block.
   */
  description?: string;
  /**
   * Base URL prefix applied to every entry href. Default `/`; pass
   * an absolute origin (e.g. `https://example.com`) to produce an
   * outward-facing llms.txt that third-party crawlers can consume
   * without resolving against the host.
   */
  basePath?: string;
  /**
   * When true, include each entry's body verbatim under its heading.
   * This produces the `llms-full.txt` variant — significantly larger
   * output, but lets consumers avoid a second fetch per entry.
   */
  full?: boolean;
  /**
   * Include entries with `data.draft === true` (default: false).
   * Production sites should leave this off so unpublished content
   * doesn't leak to external crawlers.
   */
  includeDrafts?: boolean;
  /**
   * Override the per-entry summary line. Defaults to
   * `entry.data.description ?? ""`. Returning an empty string
   * omits the trailing `: {summary}` tail.
   */
  getSummary?: (entry: CollectionEntry<unknown>) => string;
}

/**
 * Generate an llms.txt document from one or more collections.
 *
 * Accepts both `Collection` instances (loaded internally) and
 * pre-loaded entry arrays so callers can pipe in filtered/transformed
 * data without paying for a second scan.
 */
export async function generateLLMSTxt(
  inputs: LLMSTxtInput[],
  options: GenerateLLMSTxtOptions = {}
): Promise<string> {
  const {
    siteName,
    description,
    basePath = "/",
    full = false,
    includeDrafts = false,
    getSummary,
  } = options;

  const lines: string[] = [];
  if (siteName) {
    lines.push(`# ${siteName}`);
    if (description) {
      lines.push("");
      lines.push(`> ${description}`);
    }
    lines.push("");
  }

  for (const input of inputs) {
    const entries = await loadInput(input);
    const visible = includeDrafts
      ? entries
      : entries.filter((e) => !(e.data as { draft?: unknown })?.draft);
    if (visible.length === 0) continue;

    // Sort within each collection by slug for deterministic output —
    // llms.txt is often diffed by agents/tools, and a stable order
    // keeps those diffs meaningful.
    const sorted = [...visible].sort((a, b) =>
      a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
    );

    lines.push(`## ${input.name}`);
    lines.push("");
    for (const entry of sorted) {
      const title =
        typeof (entry.data as { title?: unknown })?.title === "string"
          ? String((entry.data as { title: string }).title)
          : entry.slug || "index";
      const href = joinHref(basePath, input.name, entry.slug);
      const summary = getSummary
        ? getSummary(entry)
        : typeof (entry.data as { description?: unknown })?.description === "string"
          ? String((entry.data as { description: string }).description)
          : "";
      const tail = summary ? `: ${summary}` : "";
      lines.push(`- [${title}](${href})${tail}`);
      if (full) {
        lines.push("");
        lines.push(entry.content);
        lines.push("");
      }
    }
    lines.push("");
  }

  // Trim the trailing blank line — the "ends in newline" convention
  // is handled by the single final `\n` below so we don't accumulate
  // extra blank tail lines across collections.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

async function loadInput(input: LLMSTxtInput): Promise<CollectionEntry<unknown>[]> {
  if ("entries" in input) return input.entries;
  // CollectionReader.all() yields the same shape as
  // CollectionEntry<unknown>[] — the cast here is a trivial widening.
  const entries = await input.collection.all();
  return entries as CollectionEntry<unknown>[];
}

function joinHref(base: string, collectionName: string, slug: string): string {
  const parts = [collectionName, slug].filter((x) => x !== "" && x !== "/");
  const tail = parts.join("/").replace(/\/+/g, "/");
  if (base.startsWith("http")) {
    // Preserve the `//` after the protocol — we only collapse slashes
    // in the path portion, so `https://example.com/docs/foo` survives
    // intact instead of becoming `https:/example.com/docs/foo`.
    const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    return tail ? `${trimmedBase}/${tail}` : trimmedBase;
  }
  if (base === "" || base === "/") {
    return `/${tail}`.replace(/\/+/g, "/");
  }
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${leading}/${tail}`.replace(/\/+/g, "/");
}

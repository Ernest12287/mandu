/**
 * Metadata Routes — Runtime Handlers
 *
 * Pure renderers + request dispatchers for the four file-convention
 * metadata routes (`sitemap.ts`, `robots.ts`, `llms.txt.ts`,
 * `manifest.ts`). Each `render*` function takes the validated, typed
 * value and produces the serialized body. The `handleMetadataRoute`
 * dispatcher wires an imported user module to a `Response`, including
 * validation, caching headers, and typed error responses.
 *
 * Design notes
 * ────────────
 * • Renderers are pure and synchronous so tests can hit them directly
 *   without mocking Request/Response.
 * • Validation runs AFTER the user function resolves but BEFORE we
 *   attempt to render — this lets us surface the exact Zod error
 *   (with the failing path) in the 500 response instead of crashing
 *   inside `renderSitemap` / `renderManifest` when a required field
 *   is missing.
 * • Cache headers are `public, max-age=3600` by default. Callers can
 *   opt in to custom values via the `cache` option, and opting out
 *   entirely is supported by passing `cache: false`.
 *
 * @module routes/metadata-routes
 */
import {
  SitemapSchema,
  RobotsSchema,
  WebAppManifestSchema,
  METADATA_ROUTES,
  type MetadataRouteKind,
  type Sitemap,
  type SitemapEntry,
  type Robots,
  type RobotsRule,
  type WebAppManifest,
} from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// XML / text escape helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Escape characters that are illegal in XML text / attribute content.
 * We deliberately avoid bringing in a dependency here — the five
 * predefined entities cover every case we emit.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Normalize a Date / date-like string into an ISO-8601 string. We
 * accept strings verbatim to let users pass pre-formatted values
 * (e.g. a DB-returned timestamp) without re-parsing.
 */
function formatDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sitemap rendering
// ═══════════════════════════════════════════════════════════════════════════

function renderSitemapEntry(entry: SitemapEntry): string {
  const lines: string[] = ["  <url>"];
  lines.push(`    <loc>${escapeXml(entry.url)}</loc>`);

  if (entry.lastModified !== undefined) {
    lines.push(`    <lastmod>${escapeXml(formatDate(entry.lastModified))}</lastmod>`);
  }
  if (entry.changeFrequency) {
    lines.push(`    <changefreq>${entry.changeFrequency}</changefreq>`);
  }
  if (entry.priority !== undefined) {
    lines.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
  }
  if (entry.images?.length) {
    for (const image of entry.images) {
      lines.push("    <image:image>");
      lines.push(`      <image:loc>${escapeXml(image)}</image:loc>`);
      lines.push("    </image:image>");
    }
  }
  if (entry.alternates?.languages) {
    for (const [lang, url] of Object.entries(entry.alternates.languages)) {
      lines.push(
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(lang)}" href="${escapeXml(url)}" />`
      );
    }
  }
  lines.push("  </url>");
  return lines.join("\n");
}

/**
 * Render a sitemap entry array to XML 1.0. The `xmlns:image` and
 * `xmlns:xhtml` namespaces are added on demand so a plain sitemap
 * stays as compact as possible.
 */
export function renderSitemap(entries: Sitemap): string {
  const hasImages = entries.some((e) => e.images && e.images.length > 0);
  const hasAlternates = entries.some((e) => e.alternates?.languages);

  const namespaces = ['xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'];
  if (hasImages) {
    namespaces.push('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
  }
  if (hasAlternates) {
    namespaces.push('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset ${namespaces.join(" ")}>`,
    ...entries.map(renderSitemapEntry),
    "</urlset>",
  ];
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Robots rendering
// ═══════════════════════════════════════════════════════════════════════════

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function renderRobotsRule(rule: RobotsRule): string {
  const lines: string[] = [];
  const userAgents = toArray(rule.userAgent);
  for (const ua of userAgents) {
    lines.push(`User-agent: ${ua}`);
  }
  for (const path of toArray(rule.allow)) {
    lines.push(`Allow: ${path}`);
  }
  for (const path of toArray(rule.disallow)) {
    lines.push(`Disallow: ${path}`);
  }
  if (rule.crawlDelay !== undefined) {
    lines.push(`Crawl-delay: ${rule.crawlDelay}`);
  }
  return lines.join("\n");
}

/**
 * Render a `Robots` object to a robots.txt text body. Rule groups are
 * separated by blank lines; `sitemap:` and `host:` directives go at
 * the bottom per convention.
 */
export function renderRobots(robots: Robots): string {
  const sections: string[] = [];
  const rules = toArray(robots.rules);
  for (const rule of rules) {
    sections.push(renderRobotsRule(rule));
  }
  if (robots.host) {
    sections.push(`Host: ${robots.host}`);
  }
  for (const sitemap of toArray(robots.sitemap)) {
    sections.push(`Sitemap: ${sitemap}`);
  }
  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Web App Manifest rendering
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Serialize a `WebAppManifest` to JSON. Formatting is deterministic
 * (2-space indent) so CDN caches don't generate spurious diffs when
 * the underlying object is logically unchanged.
 */
export function renderManifest(manifest: WebAppManifest): string {
  return JSON.stringify(manifest, null, 2);
}

// ═══════════════════════════════════════════════════════════════════════════
// llms.txt passthrough
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Identity-ish passthrough for llms.txt content. Exposed as a function
 * so the dispatcher can treat every route type uniformly — and so
 * future formats (e.g. stripping BOM, normalizing line endings) can be
 * added here without touching call sites.
 */
export function renderLlmsTxt(content: string): string {
  if (typeof content !== "string") {
    throw new TypeError(
      `[@mandujs/core/routes] llms.txt default export must return a string, got ${typeof content}`
    );
  }
  return content;
}

// ═══════════════════════════════════════════════════════════════════════════
// Dispatcher
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options passed to {@link handleMetadataRoute}. `sourceFile` is used
 * purely for error messages — it appears in the 500 body when the user
 * export throws or returns an invalid shape, which dramatically
 * shortens the edit-test loop.
 */
export interface MetadataRouteHandlerOptions {
  /** Which of the four metadata routes we're serving. */
  kind: MetadataRouteKind;
  /** The imported user module's default export (not yet invoked). */
  userExport: unknown;
  /** The source file path, surfaced in error messages. */
  sourceFile?: string;
  /**
   * Cache-Control header. `true` (default) emits
   * `public, max-age=3600`. `false` omits the header. A string is
   * passed through unchanged.
   */
  cache?: boolean | string;
}

/**
 * Typed error thrown when metadata route validation fails. The message
 * includes the source file + Zod path so the developer can jump
 * directly to the offending line.
 */
export class MetadataRouteValidationError extends Error {
  readonly kind: MetadataRouteKind;
  readonly issues: { path: string; message: string }[];
  readonly sourceFile?: string;

  constructor(
    kind: MetadataRouteKind,
    issues: { path: string; message: string }[],
    sourceFile?: string
  ) {
    const header = sourceFile
      ? `[@mandujs/core/routes] Invalid ${kind} value in ${sourceFile}`
      : `[@mandujs/core/routes] Invalid ${kind} value`;
    const body = issues.map((i) => `  • ${i.path || "(root)"}: ${i.message}`).join("\n");
    super(`${header}\n${body}`);
    this.name = "MetadataRouteValidationError";
    this.kind = kind;
    this.issues = issues;
    this.sourceFile = sourceFile;
  }
}

function defaultCacheControl(cache: boolean | string | undefined): string | null {
  if (cache === false) return null;
  if (typeof cache === "string") return cache;
  return "public, max-age=3600";
}

/**
 * Look up the Content-Type + URL pattern for a metadata route kind.
 * Exposed so fs-scanner / manifest builders can reuse the same table
 * without reaching into METADATA_ROUTES directly.
 */
export function getMetadataRouteMeta(kind: MetadataRouteKind) {
  return METADATA_ROUTES[kind];
}

/**
 * Dispatch a metadata route request.
 *
 * Pipeline:
 *   1. Extract the default-export function from the imported module.
 *   2. Invoke it (await its result).
 *   3. Zod-validate the returned shape.
 *   4. Render the correct body format.
 *   5. Wrap in a Response with the right Content-Type + cache headers.
 *
 * Any failure in steps 1-4 yields a typed 500 Response whose body
 * includes the source file and Zod issue path.
 */
export async function handleMetadataRoute(
  options: MetadataRouteHandlerOptions
): Promise<Response> {
  const { kind, userExport, sourceFile } = options;
  const { contentType } = METADATA_ROUTES[kind];
  const cacheControl = defaultCacheControl(options.cache);

  const fn = extractDefaultFn(userExport);
  if (!fn) {
    return errorResponse(
      kind,
      sourceFile,
      "Module default export must be a function. " +
        `Expected \`export default function ${friendlyName(kind)}() { ... }\`.`
    );
  }

  let result: unknown;
  try {
    result = await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(kind, sourceFile, `User function threw: ${message}`);
  }

  try {
    const body = renderValidated(kind, result, sourceFile);
    const headers = new Headers({ "Content-Type": contentType });
    if (cacheControl) headers.set("Cache-Control", cacheControl);
    return new Response(body, { status: 200, headers });
  } catch (err) {
    if (err instanceof MetadataRouteValidationError) {
      return errorResponse(kind, sourceFile, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(kind, sourceFile, `Render failed: ${message}`);
  }
}

/**
 * Validate + render a single metadata route value. Shared between the
 * production dispatcher and tests (where we often want to exercise a
 * specific branch without spinning up a Request).
 */
export function renderValidated(
  kind: MetadataRouteKind,
  value: unknown,
  sourceFile?: string
): string {
  switch (kind) {
    case "sitemap": {
      const parsed = SitemapSchema.safeParse(value);
      if (!parsed.success) throw zodToValidationError(kind, parsed.error, sourceFile);
      return renderSitemap(parsed.data);
    }
    case "robots": {
      const parsed = RobotsSchema.safeParse(value);
      if (!parsed.success) throw zodToValidationError(kind, parsed.error, sourceFile);
      return renderRobots(parsed.data);
    }
    case "llms-txt": {
      if (typeof value !== "string") {
        throw new MetadataRouteValidationError(
          kind,
          [{ path: "(root)", message: `expected string, got ${typeof value}` }],
          sourceFile
        );
      }
      return renderLlmsTxt(value);
    }
    case "manifest": {
      const parsed = WebAppManifestSchema.safeParse(value);
      if (!parsed.success) throw zodToValidationError(kind, parsed.error, sourceFile);
      return renderManifest(parsed.data as WebAppManifest);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Accept both a raw function export and a `{ default: fn }` namespace
 * object (the shape returned by `await import(...)`). Returns the
 * callable or null if neither is available.
 */
function extractDefaultFn(userExport: unknown): ((...args: unknown[]) => unknown) | null {
  if (typeof userExport === "function") {
    return userExport as (...args: unknown[]) => unknown;
  }
  if (userExport && typeof userExport === "object") {
    const maybeDefault = (userExport as { default?: unknown }).default;
    if (typeof maybeDefault === "function") {
      return maybeDefault as (...args: unknown[]) => unknown;
    }
  }
  return null;
}

function friendlyName(kind: MetadataRouteKind): string {
  switch (kind) {
    case "sitemap":
      return "sitemap";
    case "robots":
      return "robots";
    case "llms-txt":
      return "llmsTxt";
    case "manifest":
      return "manifest";
  }
}

function zodToValidationError(
  kind: MetadataRouteKind,
  error: { issues: { path: (string | number)[]; message: string }[] },
  sourceFile?: string
): MetadataRouteValidationError {
  const issues = error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
  return new MetadataRouteValidationError(kind, issues, sourceFile);
}

/**
 * Build a 500 Response with a plain-text body describing the problem.
 * Mirrors how Next.js surfaces metadata errors — the text is read
 * directly from the browser "View Source", no JSON framing.
 */
function errorResponse(
  kind: MetadataRouteKind,
  sourceFile: string | undefined,
  detail: string
): Response {
  const location = sourceFile ? ` (${sourceFile})` : "";
  const body = `# Mandu metadata route error: ${kind}${location}\n${detail}\n`;
  return new Response(body, {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

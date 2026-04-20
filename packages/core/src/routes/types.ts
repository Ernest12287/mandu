/**
 * Metadata Route Types
 *
 * File-convention types for Next.js-style metadata routes. Each type
 * matches the Next.js shape so developers familiar with that ecosystem
 * can drop their existing contract in verbatim.
 *
 * Exposed via `@mandujs/core/routes`. For the legacy free-form SEO
 * metadata types (Metadata, Icons, OpenGraph, ...) see `@mandujs/core`
 * / `packages/core/src/seo/types.ts` — this module is scoped strictly
 * to the file-convention routes (sitemap.ts, robots.ts, llms.txt.ts,
 * manifest.ts) and their runtime handlers.
 *
 * @module routes/types
 */
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Sitemap (sitemap.ts → /sitemap.xml)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Change frequency hint from the Sitemaps XML schema.
 * @see https://www.sitemaps.org/protocol.html#changefreqdef
 */
export type ChangeFrequency =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

/** Alternate language URLs for a sitemap entry (hreflang). */
export interface SitemapAlternates {
  languages?: Record<string, string>;
}

/**
 * Single sitemap entry. Next.js shape — `url` is required, everything
 * else is optional. `lastModified` accepts a `Date` or ISO string so
 * users can return e.g. `fs.statSync(...).mtime` directly.
 */
export interface SitemapEntry {
  /** Absolute URL of the page. */
  url: string;
  /** Last modification time of the page. */
  lastModified?: string | Date;
  /** Crawl frequency hint for search engines. */
  changeFrequency?: ChangeFrequency;
  /** Priority hint [0.0, 1.0]. */
  priority?: number;
  /** Alternate URLs for i18n / hreflang. */
  alternates?: SitemapAlternates;
  /** Optional image URLs associated with the page. */
  images?: string[];
}

/** Full sitemap: an array of SitemapEntry. */
export type Sitemap = SitemapEntry[];

// ═══════════════════════════════════════════════════════════════════════════
// Robots (robots.ts → /robots.txt)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Single rule group in robots.txt. Each group applies to one or more
 * user agents; `allow` / `disallow` accept a single string or array.
 */
export interface RobotsRule {
  /** User agent string ("*", "Googlebot", ...). */
  userAgent: string | string[];
  /** Paths explicitly permitted. */
  allow?: string | string[];
  /** Paths explicitly denied. */
  disallow?: string | string[];
  /** Crawl delay in seconds. */
  crawlDelay?: number;
}

/**
 * Complete robots.txt definition. Matches Next.js `MetadataRoute.Robots`.
 */
export interface Robots {
  /** One or more rule groups. */
  rules: RobotsRule | RobotsRule[];
  /** Sitemap URL(s) to announce. */
  sitemap?: string | string[];
  /** Host directive (Yandex). */
  host?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Web App Manifest (manifest.ts → /manifest.webmanifest)
// ═══════════════════════════════════════════════════════════════════════════

export type DisplayMode = "fullscreen" | "standalone" | "minimal-ui" | "browser";
export type Orientation =
  | "any"
  | "natural"
  | "landscape"
  | "landscape-primary"
  | "landscape-secondary"
  | "portrait"
  | "portrait-primary"
  | "portrait-secondary";

/**
 * Icon descriptor in a web app manifest. `src` + `sizes` + `type` is
 * the minimal W3C contract; `purpose` is optional but recommended for
 * maskable icons.
 */
export interface WebAppManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: "any" | "maskable" | "monochrome" | string;
}

/** Shortcut entry (jumplist) in a web app manifest. */
export interface WebAppManifestShortcut {
  name: string;
  short_name?: string;
  description?: string;
  url: string;
  icons?: WebAppManifestIcon[];
}

/**
 * Web app manifest (application/manifest+json). We type the common
 * subset defined by the W3C spec; unknown keys pass through via the
 * index signature so callers can add experimental fields.
 */
export interface WebAppManifest {
  /** Full name of the application (required per W3C). */
  name: string;
  /** Short name for home-screen / launcher. */
  short_name: string;
  /** Description. */
  description?: string;
  /** Starting URL. */
  start_url?: string;
  /** Application scope (URL prefix). */
  scope?: string;
  /** Display mode. */
  display?: DisplayMode;
  /** Orientation preference. */
  orientation?: Orientation;
  /** Primary theme color (toolbar). */
  theme_color?: string;
  /** Background color (splash). */
  background_color?: string;
  /** Icons — at least one is required by the spec. */
  icons: WebAppManifestIcon[];
  /** Language tag (e.g. "en-US"). */
  lang?: string;
  /** Text direction. */
  dir?: "ltr" | "rtl" | "auto";
  /** Categories (taxonomy). */
  categories?: string[];
  /** Shortcuts shown in the app launcher. */
  shortcuts?: WebAppManifestShortcut[];
  /** Additional W3C fields pass through unchanged. */
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// Default export function signatures
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default-export contract for `app/sitemap.ts`. Return `Sitemap` or a
 * Promise — Mandu awaits the result during the request.
 */
export type SitemapFn = () => Sitemap | Promise<Sitemap>;

/**
 * Default-export contract for `app/robots.ts`.
 */
export type RobotsFn = () => Robots | Promise<Robots>;

/**
 * Default-export contract for `app/llms.txt.ts`. Return the complete
 * text body; Mandu serves it verbatim with `text/plain` content type.
 */
export type LlmsTxtFn = () => string | Promise<string>;

/**
 * Default-export contract for `app/manifest.ts`.
 */
export type ManifestFn = () => WebAppManifest | Promise<WebAppManifest>;

// ═══════════════════════════════════════════════════════════════════════════
// Metadata route kinds (for manifest / fs-scanner)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Discriminator used in `RouteSpec.kind === "metadata"` entries and in
 * `ScannedFile.metadataKind` when fs-scanner detects one of the four
 * metadata files.
 */
export type MetadataRouteKind = "sitemap" | "robots" | "llms-txt" | "manifest";

/**
 * Static table mapping each metadata route kind to the file name the
 * scanner recognizes, the URL pattern that serves the content, and the
 * Content-Type header. Kept deliberately flat so both fs-scanner and
 * the runtime dispatcher can read from the same source of truth.
 */
export const METADATA_ROUTES: Record<
  MetadataRouteKind,
  { fileBase: string; pattern: string; contentType: string }
> = {
  sitemap: {
    fileBase: "sitemap",
    pattern: "/sitemap.xml",
    contentType: "application/xml; charset=utf-8",
  },
  robots: {
    fileBase: "robots",
    pattern: "/robots.txt",
    contentType: "text/plain; charset=utf-8",
  },
  "llms-txt": {
    // `llms.txt.ts` — filename contains a dot before the extension to
    // mirror the served path (/llms.txt). Detected specifically in
    // `detectMetadataFile()` since it doesn't match the common
    // `<name>.<ext>` shape.
    fileBase: "llms.txt",
    pattern: "/llms.txt",
    contentType: "text/plain; charset=utf-8",
  },
  manifest: {
    fileBase: "manifest",
    pattern: "/manifest.webmanifest",
    contentType: "application/manifest+json; charset=utf-8",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Zod schemas — runtime validation of user-returned values
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validates a single sitemap entry. `url` must be a URL-like string;
 * we accept both protocol-absolute URLs and site-root-relative paths
 * (`/docs/...`) so users building a sitemap for an internal base can
 * return relative URLs. `lastModified` accepts Date or date-like string.
 */
export const SitemapEntrySchema = z.object({
  url: z
    .string()
    .min(1, "SitemapEntry.url must not be empty")
    .refine(
      (v) => /^(https?:\/\/|\/)/.test(v),
      "SitemapEntry.url must be absolute (http(s)://...) or site-root-relative (/...)"
    ),
  lastModified: z
    .union([z.date(), z.string().min(1)])
    .optional(),
  changeFrequency: z
    .enum(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"])
    .optional(),
  priority: z.number().min(0).max(1).optional(),
  alternates: z
    .object({ languages: z.record(z.string()).optional() })
    .optional(),
  images: z.array(z.string().min(1)).optional(),
});

export const SitemapSchema = z.array(SitemapEntrySchema);

export const RobotsRuleSchema = z.object({
  userAgent: z.union([z.string().min(1), z.array(z.string().min(1))]),
  allow: z.union([z.string(), z.array(z.string())]).optional(),
  disallow: z.union([z.string(), z.array(z.string())]).optional(),
  crawlDelay: z.number().nonnegative().optional(),
});

export const RobotsSchema = z.object({
  rules: z.union([RobotsRuleSchema, z.array(RobotsRuleSchema)]),
  sitemap: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  host: z.string().optional(),
});

export const WebAppManifestIconSchema = z.object({
  src: z.string().min(1, "WebAppManifest icon.src must not be empty"),
  sizes: z.string().optional(),
  type: z.string().optional(),
  purpose: z.string().optional(),
});

/**
 * Minimum W3C-compliant manifest — `name`, `short_name`, and at least
 * one icon. Unknown keys pass through via `.passthrough()` so users
 * can add experimental manifest fields without fighting the validator.
 */
export const WebAppManifestSchema = z
  .object({
    name: z.string().min(1, "WebAppManifest.name is required"),
    short_name: z.string().min(1, "WebAppManifest.short_name is required"),
    description: z.string().optional(),
    start_url: z.string().optional(),
    scope: z.string().optional(),
    display: z
      .enum(["fullscreen", "standalone", "minimal-ui", "browser"])
      .optional(),
    orientation: z
      .enum([
        "any",
        "natural",
        "landscape",
        "landscape-primary",
        "landscape-secondary",
        "portrait",
        "portrait-primary",
        "portrait-secondary",
      ])
      .optional(),
    theme_color: z.string().optional(),
    background_color: z.string().optional(),
    icons: z
      .array(WebAppManifestIconSchema)
      .min(1, "WebAppManifest.icons must contain at least one icon"),
    lang: z.string().optional(),
    dir: z.enum(["ltr", "rtl", "auto"]).optional(),
    categories: z.array(z.string()).optional(),
    shortcuts: z
      .array(
        z.object({
          name: z.string().min(1),
          short_name: z.string().optional(),
          description: z.string().optional(),
          url: z.string().min(1),
          icons: z.array(WebAppManifestIconSchema).optional(),
        })
      )
      .optional(),
  })
  .passthrough();

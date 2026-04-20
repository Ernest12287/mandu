---
title: Metadata Routes
status: mvp
owner: core
updated: 2026-04-19
order: 7
---

# Metadata Routes

Mandu auto-discovers four file-convention metadata routes under `app/`.
Drop a single TypeScript file and Mandu serves it at the right URL with
the right `Content-Type`, with zero build-script plumbing.

| File                 | Route                      | Content-Type                      |
| -------------------- | -------------------------- | --------------------------------- |
| `app/sitemap.ts`     | `/sitemap.xml`             | `application/xml; charset=utf-8`  |
| `app/robots.ts`      | `/robots.txt`              | `text/plain; charset=utf-8`       |
| `app/llms.txt.ts`    | `/llms.txt`                | `text/plain; charset=utf-8`       |
| `app/manifest.ts`    | `/manifest.webmanifest`    | `application/manifest+json; charset=utf-8` |

Each file must sit directly under `app/` — nested copies
(`app/admin/sitemap.ts`, etc.) are rejected by the scanner so your
routing stays unambiguous.

## Contract

Every metadata file exports a default function returning the typed
payload. The function may be synchronous or `async`. Types live at
`@mandujs/core/routes`.

### `app/sitemap.ts`

```ts
import type { SitemapEntry } from '@mandujs/core/routes';

export default async function sitemap(): Promise<SitemapEntry[]> {
  return [
    {
      url: 'https://example.com/',
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    { url: 'https://example.com/docs', lastModified: new Date() },
  ];
}
```

Per-entry fields:

- `url` **(required)** — absolute `https://` or site-root-relative `/` URL.
- `lastModified` — `Date` or ISO-8601 string.
- `changeFrequency` — `"always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never"`.
- `priority` — number between `0` and `1`.
- `alternates.languages` — hreflang map (`{ en: '...', ko: '...' }`).
- `images` — array of image URLs (emits `<image:image>` entries).

### `app/robots.ts`

```ts
import type { Robots } from '@mandujs/core/routes';

export default function robots(): Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: '/admin' },
      { userAgent: 'BadBot', disallow: '/' },
    ],
    sitemap: 'https://example.com/sitemap.xml',
    host: 'example.com',
  };
}
```

Each rule group accepts `userAgent` (string or array), `allow`,
`disallow`, and `crawlDelay`. Top-level `sitemap` can be a single URL
or an array.

### `app/llms.txt.ts`

```ts
export default async function llmsTxt(): Promise<string> {
  return `# My site

Documentation index for LLMs.

- [Home](/) - Landing page
- [Docs](/docs) - User guides
`;
}
```

Returns the raw `text/plain` body — Mandu passes it through
unchanged. For collection-backed generation, combine with
`@mandujs/core/content` helpers:

```ts
import { generateLLMSTxt } from '@mandujs/core/content';
import { docs } from '../src/collections';

export default () => generateLLMSTxt([{ name: 'docs', collection: docs }], {
  siteName: 'Mandu',
  baseUrl: 'https://example.com',
});
```

### `app/manifest.ts`

```ts
import type { WebAppManifest } from '@mandujs/core/routes';

export default function manifest(): WebAppManifest {
  return {
    name: 'Mandu Demo',
    short_name: 'Mandu',
    description: 'Issue #206 demo',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#000000',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
```

Required: `name`, `short_name`, and at least one `icons[].src` entry.
Every additional W3C field (`shortcuts`, `categories`, `dir`, …) is
accepted and serialized verbatim.

## Behavior

- **Caching.** Responses ship with `Cache-Control: public, max-age=3600`
  by default. The contract matches Next.js for consistency; you can
  edit it via a middleware if you need tighter control.
- **Dev HMR.** Edits reload immediately — each request re-imports the
  module (dev) or uses the compiled bundle (prod) just like API routes.
- **Validation.** Each export is Zod-checked before rendering. A missing
  `name` in `manifest.ts`, a malformed `url` in `sitemap.ts`, or a
  non-string return from `llms.txt.ts` surfaces as a 500 with the source
  file + Zod path in the body — no silent fallback.
- **Error bodies** are plain text, greppable, and include the source
  filename so the failing line is one click away in your editor:

  ```text
  # Mandu metadata route error: sitemap (app/sitemap.ts)
  [@mandujs/core/routes] Invalid sitemap value in app/sitemap.ts
    • 0.url: SitemapEntry.url must be absolute (http(s)://...) or site-root-relative (/...)
  ```

- **Coexistence with `public/`.** If you ship a static `public/sitemap.xml`
  alongside `app/sitemap.ts`, the **file route wins** — the static
  server falls behind the route dispatcher. Delete one or the other
  to resolve the ambiguity.

## Advanced

The runtime helpers are exposed from `@mandujs/core/routes` so you can
bypass auto-discovery when needed:

```ts
import {
  renderSitemap,
  renderRobots,
  renderManifest,
  renderLlmsTxt,
  handleMetadataRoute,
} from '@mandujs/core/routes';
```

Use cases:

- Custom endpoints (e.g. `/sitemap/page-2.xml`) in a regular
  `app/sitemap/[page].xml/route.ts`.
- Writing out static files from a build script (legacy flow).
- Returning a `Response` from a generic handler:

  ```ts
  import { handleMetadataRoute } from '@mandujs/core/routes';

  export async function GET() {
    return handleMetadataRoute({
      kind: 'sitemap',
      userExport: () => [{ url: 'https://example.com/' }],
      cache: 'public, max-age=60',
    });
  }
  ```

## Back-compat

The previous prebuild-script flow (generating a static
`public/sitemap.xml` from a script) still works. This feature is
**additive** — nothing breaks if you keep your existing pipeline.

## Further reading

- [Next.js Metadata Routes](https://nextjs.org/docs/app/api-reference/file-conventions/metadata) — DX model this feature mirrors.
- [sitemaps.org](https://www.sitemaps.org/protocol.html) — XML schema reference.
- [robotstxt.org](https://www.robotstxt.org/) — robots.txt directives.
- [W3C Web App Manifest](https://www.w3.org/TR/appmanifest/) — PWA manifest spec.
- [llmstxt.org](https://llmstxt.org/) — LLM ingestion convention.

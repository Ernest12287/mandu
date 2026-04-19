---
title: Content Collections
status: mvp
owner: core
updated: 2026-04-19
---

# Content Collections

`@mandujs/core/content` provides a first-class content-collection API
for docs sites, blogs, and any project that stores human-authored
content as frontmatter + Markdown on disk. Think `astro:content` or
Fumadocs, reshaped around Mandu's build model.

## Quick start

### 1. Author content

```markdown
---
title: Hello Mandu
order: 1
description: First page of the docs
tags:
  - intro
  - basics
draft: false
---

# Hello Mandu

Welcome! This is the first docs entry.
```

Save as `content/docs/hello.md` (any directory works — you point the
collection at it in the config file below).

### 2. Define the collection

```ts
// content.config.ts
import { defineCollection, z } from '@mandujs/core/content';

export const docs = defineCollection({
  path: 'content/docs',
  schema: z.object({
    title: z.string(),
    order: z.number().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});
```

### 3. Read it anywhere

```ts
import { docs } from './content.config';

const entries = await docs.all();
// entries = [
//   { slug: 'hello', data: { title: 'Hello Mandu', order: 1, ... }, content: '# Hello Mandu\n\n...', filePath: '/abs/path/hello.md' }
// ]

const intro = await docs.get('hello');
intro?.data.title; // "Hello Mandu" (typed)

const rendered = await docs.getCompiled('hello');
// rendered.Component — render in JSX; rendered.html — string snapshot
```

## API surface

### `defineCollection(options)`

Returns a `Collection<T>` instance when called with
`{ path, schema?, ... }`. The legacy `{ loader, schema }` shape
(used by `ContentLayer`) is still accepted — the pass-through branch
preserves backwards compatibility for existing projects.

Options:

| Field | Purpose |
|---|---|
| `path` | Directory to scan (relative to `root`; absolute OK) |
| `schema` | Zod schema for frontmatter validation |
| `extensions` | Override included file extensions (default `.md`/`.mdx`/`.markdown`) |
| `slug` | `({ path, data }) => string` — force a specific slug |
| `slugOptions` | Forwarded to `slugFromPath` for default-slug tuning |
| `sort` | `(a, b) => number` — override the default order |
| `root` | Pin the project root (defaults to `process.cwd()`) |

### `Collection` methods

- `load()` — scan, parse, validate, cache. Safe to call concurrently.
- `all()` — alias for `load()`.
- `get(slug)` — look up a single entry by its slug.
- `getCompiled(slug)` — lazy MDX component (falls back to `<pre>` if
  `unified` + `remark-*` + `rehype-stringify` are not installed).
- `invalidate()` — drop the in-memory cache (used by tests and the
  future dev-mode file watcher).

### Slug generation

```ts
import { slugFromPath } from '@mandujs/core/content';

slugFromPath('getting-started/install.md');
// "getting-started/install"
slugFromPath('API_v2.md', { kebabCase: false });
// "API_v2"
```

Default behavior: normalize `\\` → `/`, strip markdown extensions,
drop `/index` suffix, kebab-case per segment, collapse duplicate
slashes.

### Sidebar generator

```ts
import { generateSidebar } from '@mandujs/core/content';

const sidebar = await generateSidebar(docs, { basePath: '/docs' });
// [
//   { title: 'Hello Mandu', href: '/docs/hello' },
//   { title: 'guide', href: '/docs/guide', children: [...] }
// ]
```

Drafts are filtered by default. Pass `includeDrafts: true` for
preview builds. Sort is numeric-aware so `02-intro` sorts before
`10-advanced` out of the box.

### llms.txt generator

```ts
import { generateLLMSTxt } from '@mandujs/core/content';

const txt = await generateLLMSTxt(
  [{ name: 'docs', collection: docs }],
  { siteName: 'My Site', basePath: 'https://example.com' }
);

// Write to llms.txt in build output
await Bun.write('public/llms.txt', txt);
```

Pass `full: true` to inline every entry's body — use this for the
`llms-full.txt` convention.

### Generated types

```ts
import { generateContentTypes } from '@mandujs/core/content';
import { docs, blog } from './content.config';

generateContentTypes(
  { docs, blog },
  { root: process.cwd() }
);
// Writes .mandu/generated/content-types.d.ts
```

The emitter creates aliases `EntryDocs`, `EntryBlog`, a
`CollectionMap` interface, and a `CollectionName` union so the
collection namespace is queryable from TypeScript.

## MVP scope guardrails

Explicitly out of scope for this pass — tracked as follow-ups:

- Full MDX component resolution (import/export inside `.mdx`, React
  Server Components inside MDX)
- Hot-reload of content (chokidar watcher on the collection dir)
- i18n collection support
- Nested collections / cross-collection references

Projects that need any of the above today can drop back to the
existing `ContentLayer` (`@mandujs/core/content` `defineContentConfig`
+ `glob()` loader) — `defineCollection` dispatches on the `loader` key
so both APIs coexist.

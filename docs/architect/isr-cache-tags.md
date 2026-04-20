---
title: ISR + cache tags
phase: 18.ζ
audience: app developers, platform engineers
---

# ISR + cache tags

Phase 18.ζ ships **Incremental Static Regeneration** with **tag-based invalidation** — the same programming model as Next.js' `revalidate` + `revalidateTag`, but rendered and served by the Mandu runtime, not a vendor edge.

The feature builds on Wave E1 γ (`generateStaticParams` + `.mandu/prerendered/`): prerendered HTML is still served at the very top of the dispatcher for pure-static routes, while ISR sits right after it to serve hot-path dynamic routes from an in-memory cache with optional stale-while-revalidate.

## Mental model

```
request
  └── γ  prerendered pass-through       (disk → response, PRERENDERED)
  └── ζ  ISR lookup                     (memory → response, HIT/STALE)
  └── ε  middleware chain               (csrf, session, auth, rate-limit)
  └── β  route dispatch + SSR
         └── ζ  cache save              (response → memory, MISS)
```

Three of those arrows are ζ; everything else existed before.

## Next.js comparison

| Concept                 | Next.js (App Router)                    | Mandu (Phase 18.ζ)                               |
| ----------------------- | --------------------------------------- | ------------------------------------------------ |
| Fresh TTL               | `export const revalidate = 60`          | `filling.loader(fn, { revalidate: 60 })`         |
| Per-request TTL         | `fetch(url, { next: { revalidate } })`  | `return { _cache: { maxAge } }` in loader        |
| Tag a cache entry       | `fetch(url, { next: { tags } })`        | `return { _cache: { tags } }` or `ctx.cache.tag` |
| Invalidate tag          | `revalidateTag('posts')`                | `revalidateTag('posts')` / `revalidate('posts')` |
| Invalidate path         | `revalidatePath('/blog')`               | `revalidatePath('/blog')`                        |
| Stale-while-revalidate  | implicit (ISR)                          | explicit `staleWhileRevalidate` (seconds)        |
| CDN alignment           | Vercel-specific                         | `Cache-Control: public, max-age=…, swr=…`        |
| Debug header            | `x-vercel-cache`                        | `X-Mandu-Cache: HIT \| STALE \| MISS`            |

## Usage patterns

### 1. Route-level fresh TTL

```ts
// app/posts/[slug]/page.ts
export const filling = Mandu.filling<Post>()
  .loader(
    async (ctx) => ({ post: await db.getPost(ctx.params.slug) }),
    { revalidate: 60, tags: ["posts"] }
  );
```

The second argument is static — it's baked in at module load, so it's the right place for `revalidate` on an entire route.

### 2. Per-request metadata via `_cache`

```ts
.loader(async (ctx) => {
  const post = await db.getPost(ctx.params.slug);
  return {
    data: { post },
    _cache: {
      tags: ["posts", `posts:${post.id}`, `author:${post.authorId}`],
      maxAge: 3600,
      staleWhileRevalidate: 86400,
    },
  };
})
```

The runtime strips `_cache` before rendering, merges the tags with any static `filling.loader(fn, {...})` declaration, and remembers `{ maxAge, staleWhileRevalidate, tags }` for the cache save step. **Per-request tags always win** when they disagree on `maxAge` / `swr`.

### 3. Per-request metadata via `ctx.cache`

When you want type safety over a magic shape:

```ts
.loader(async (ctx) => {
  const post = await db.getPost(ctx.params.slug);
  ctx.cache.tag("posts", `posts:${post.id}`).maxAge(3600).swr(86400);
  return { post };
})
```

`ctx.cache` is a fluent builder — every call returns the same helper. Accessing `ctx.cache.meta` gives a read-only snapshot.

### 4. Global defaults via `mandu.config.ts`

```ts
// mandu.config.ts
export default {
  cache: {
    defaultMaxAge: 60,       // every non-dynamic route auto-caches 60s fresh
    defaultSwr: 86400,       // +24h SWR window
    maxEntries: 10_000,      // LRU bound
  },
};
```

This is the Next.js `export const revalidate = 60` analogue — route opt-in becomes route opt-out. A loader that wants to skip caching returns `_cache: { maxAge: 0 }` or sets `render("dynamic")`.

## Invalidation API

All three are safe to call from anywhere (webhooks, mutations, CLI commands):

```ts
import { revalidate, revalidateTag, revalidatePath } from "@mandujs/core/runtime";

// Single tag — drops every cached entry carrying this tag.
revalidateTag("posts");
revalidate("posts");                 // alias

// Specific URL — drops every cached entry whose key path matches.
revalidatePath("/blog");

// Typical webhook handler:
export const POST: Handler = async (ctx) => {
  const { postId } = await ctx.body<{ postId: string }>();
  revalidateTag(`posts:${postId}`);  // per-post
  revalidateTag("posts");            // index pages
  return ctx.ok({ ok: true });
};
```

## HTTP semantics

Every response that touches the cache path carries two response headers:

- `Cache-Control: public, max-age=<remaining-fresh>, stale-while-revalidate=<swr>` — computed at the moment of response, so downstream CDNs (Cloudflare, Fastly, CloudFront) honor exactly the TTL Mandu remembered.
- `X-Mandu-Cache: HIT | STALE | MISS | PRERENDERED` — debug tag.

| Status     | Meaning                                                              | Typical timing    |
| ---------- | -------------------------------------------------------------------- | ----------------- |
| HIT        | Fresh cache entry returned, no SSR.                                  | < 1 ms            |
| STALE      | Fresh window elapsed but SWR window still open. Served instantly.    | < 1 ms + bg render |
| MISS       | No cache entry (or expired). Full SSR; entry persisted on success.   | full SSR time     |
| PRERENDERED| γ prerendered HTML served from disk (SSG).                           | disk read         |

## LRU + SWR interplay

The in-memory store is LRU-bounded (default 1000 entries, tunable via `ManduConfig.cache.maxEntries`). A HIT promotes an entry to MRU; a STALE read does not (stale entries should stay candidates for eviction).

SWR window:

```
t0 ─────────── t0+maxAge ─────────── t0+maxAge+swr
   fresh (HIT)   stale (STALE)           expired (MISS)
```

When `swr === 0` the behavior collapses to plain ISR: past-maxAge reads are MISS and re-render synchronously.

## Custom stores

`ManduConfig.cache` accepts a `CacheStore` implementation directly, so a Redis-backed adapter is a drop-in replacement once the interface is honored. The current `"memory"` backend is the only first-party option; a future `"redis"` is reserved but not implemented.

```ts
import type { CacheStore } from "@mandujs/core/runtime";

class RedisCacheStore implements CacheStore {
  get(key) { /* … */ }
  set(key, entry) { /* … */ }
  delete(key) { /* … */ }
  deleteByPath(pathname) { /* … */ }
  deleteByTag(tag) { /* … */ }
  clear() { /* … */ }
  get size() { /* … */ }
}

// startServer({ cache: new RedisCacheStore() })
```

## Limits & pitfalls

- **Redirects are never cached.** The MISS path bails if the loader returned a redirect `Response` — same rule as Next.js.
- **`_data` SPA navigation requests bypass the cache.** They only return the loader JSON payload; the cache stores full rendered HTML so `_data` would mismatch.
- **Dynamic mode opts out entirely.** `.render("dynamic")` skips both lookup and save; every request re-runs the loader.
- **Per-request cookies survive the MISS save.** Cookies from `ctx.cookies.set()` are applied to the outgoing response, but the cached HTML does NOT preserve Set-Cookie headers — cookies are per-request by nature. Ship personalization through PPR or client-side hydration instead.

## File references

- Implementation: `packages/core/src/runtime/cache.ts`
- Dispatch wiring: `packages/core/src/runtime/server.ts` (Phase 18.ζ markers)
- Filling surface: `packages/core/src/filling/filling.ts` (`LoaderCacheOptions`)
- Context helper: `packages/core/src/filling/context.ts` (`ctx.cache`)
- Config block: `packages/core/src/config/mandu.ts` + `validate.ts`
- Regression suite: `packages/core/tests/runtime/cache.test.ts`

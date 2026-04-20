---
title: Smooth Navigation
summary: CSS View Transitions auto-inject, hover prefetch, and opt-out SPA navigation in Mandu.
issue: 192, 193, 208, 220
status: shipped
---

# Smooth Navigation

Out of the box, Mandu makes cross-document navigation feel native with two tiny
additions to every SSR response:

1. **CSS View Transitions** — supported browsers (Chrome/Edge ≥ 111,
   Safari 18.2+) play a default crossfade between the outgoing and
   incoming pages. Non-supporting browsers (Firefox, older Safari)
   silently ignore the at-rule.
2. **Hover prefetch** — a ~500-byte inline script listens for
   `mouseover` on same-origin `<a href="/...">` anchors and issues a
   one-shot `<link rel="prefetch" as="document">`. The browser cache
   services the follow-up click with no extra network round trip.

Together they close most of the perceived gap against Next.js, Astro,
and SvelteKit defaults — without requiring a client-side SPA runtime.

## What gets injected

For every SSR response, Mandu adds this to the top of `<head>` (after
your CSS link, before any user-provided head content):

```html
<style>@view-transition{navigation:auto}</style>
<script>(function(){var s=new WeakSet();document.addEventListener("mouseover",...);})();</script>
```

Both blocks are inert unless the browser opts in:

| Feature        | Chrome/Edge 111+ | Safari 18.2+ | Firefox   | Older Safari |
|----------------|------------------|--------------|-----------|--------------|
| `@view-transition` | Crossfade       | Crossfade    | Ignored   | Ignored      |
| `<link rel=prefetch>` | HTTP cache      | HTTP cache   | HTTP cache | HTTP cache |

No build step is required — the tags come for free with `mandu dev`
and `mandu start`.

## Defaults

- `transitions`: **enabled** (default `true`)
- `prefetch`: **enabled** (default `true`)

You can opt out at two granularities:

### Global opt-out (`mandu.config.ts`)

```ts
// mandu.config.ts
import type { ManduConfig } from "@mandujs/core";

export default {
  // Disable view transitions (e.g. if your app ships a custom
  // navigation animation that conflicts)
  transitions: false,

  // Disable hover prefetch (e.g. if your server is latency-bound
  // or you want to keep bandwidth tight on mobile)
  prefetch: false,
} satisfies ManduConfig;
```

Either flag can be toggled independently.

### Per-link opt-out (`data-no-prefetch`)

For most apps the hover prefetch is a net win, but a specific link
might point to a large document, a download, or an expensive
server-rendered page you don't want pre-warmed speculatively:

```tsx
// Never prefetch this link — even on hover
<a href="/reports/annual-2024.pdf" data-no-prefetch>
  Annual Report (12 MB)
</a>
```

The helper honors three additional escape hatches automatically:

- `<a download>` — skipped (downloads shouldn't be cached)
- `<a target="_blank">` — skipped (opens in a new tab)
- `<a href="https://...">` — skipped (same-origin only, `href^="/"`)

## How it works

### View Transitions (`@view-transition`)

This is a **CSS spec**, not JavaScript. The browser sees the
`@view-transition { navigation: auto }` at-rule during SSR hydration
and, on the next **cross-document** (i.e. full-reload) navigation,
takes a snapshot of the current page, renders the next page, and
crossfades between them.

Because the behavior is entirely in the browser, there is no runtime
cost — no JS to evaluate, no DOM observers, no MutationObserver
juggling. The at-rule itself is ~70 bytes in the HTML.

No per-route customization is currently supported. If you need
per-route animations or custom easing, stay tuned — a
`transitions.perRoute` sub-block is on the roadmap.

### Hover prefetch

The helper is a self-contained IIFE. It installs exactly **one**
`document`-level capture-phase `mouseover` listener and stamps each
anchor it has seen into a `WeakSet`, so the overhead per hover event
is O(1).

When it finds an eligible anchor it creates
`<link rel="prefetch" as="document">` and appends it to `<head>`. The
browser then issues a low-priority background GET for the target URL.
If you click the link within a few seconds, the HTTP cache serves
the navigation from memory.

The helper is injected inline (not as an external bundle) because:

1. At ~500 bytes compressed, an extra HTTP round trip would cost more
   than the helper saves.
2. Keeping it in `<head>` means it runs during parse, before the
   first paint — so hovers during initial page render are caught.
3. No module graph change — zero impact on the bundler's caching
   invariants.

## Opt-out SPA navigation (issue #193)

**Breaking change (v0.22+)**: Mandu now intercepts plain `<a href>`
clicks by default and routes them through the built-in client-side
router. Prior to v0.22, SPA navigation was opt-in — only
`<a data-mandu-link href="/about">` was intercepted; everything else
did a full document reload. **This has been reversed.**

The new default pairs naturally with CSS View Transitions: a plain
`<a href="/docs">` click now yields a zero-flash crossfade on
supported browsers, persists scroll / focus state, and does not
re-evaluate JavaScript bundles. You write HTML, Mandu makes it feel
like an SPA.

### What intercepts by default

Every internal same-origin `<a>` click goes through the client-side
router **unless** one of the escape hatches below fires:

| Scenario                              | Fallthrough?                       |
|---------------------------------------|------------------------------------|
| `<a href="/about">`                   | NO — intercepted (new default)     |
| `<a data-mandu-link href="/...">`     | NO — intercepted (legacy attr still works) |
| `<a data-no-spa href="/...">`         | YES — per-link opt-out             |
| `<a href="#section">` (fragment only) | YES — browser handles scroll       |
| `<a href="/about#team">` (cross-page) | NO — routed, hash preserved        |
| `<a href="mailto:...">`               | YES — mail client opens            |
| `<a href="tel:...">` / `javascript:`  | YES — browser / UA handler         |
| `<a href="https://external">`         | YES — cross-origin full nav        |
| `<a target="_blank">`                 | YES — new tab                      |
| `<a target="_top">` / `_parent`       | YES — framed nav                   |
| `<a target="_self">` (explicit)       | NO — intercepted (same frame)      |
| `<a download href="/file.pdf">`       | YES — file download                |
| Ctrl / Cmd / Shift / Alt + click      | YES — browser shortcut             |
| Middle-click / right-click            | YES — new tab / context menu       |
| `event.defaultPrevented` already set  | YES — another listener handled it  |

### Per-link opt-out (`data-no-spa`)

When a specific link must trigger a full document reload (e.g. to
force a fresh session cookie, or to navigate to a legacy non-Mandu
route), add `data-no-spa`:

```tsx
<a href="/admin/legacy-dashboard" data-no-spa>
  Legacy admin (full reload)
</a>
```

This attribute always wins — it takes precedence over the global
config setting, over `data-mandu-link`, and over everything else.

### Global opt-out (`mandu.config.ts`)

If your app was built against the pre-v0.22 opt-in behavior and you
need time to migrate, set `spa: false` to restore the legacy default:

```ts
// mandu.config.ts
import type { ManduConfig } from "@mandujs/core";

export default {
  // Revert to opt-in behavior: only `<a data-mandu-link>` is
  // intercepted, all other internal links perform a full browser
  // navigation. New code should avoid this flag — it is provided as
  // a migration escape hatch, not a long-term setting.
  spa: false,
} satisfies ManduConfig;
```

Under `spa: false` the router only intercepts anchors that explicitly
carry `data-mandu-link`, matching the pre-v0.22 contract.

### Why it's still safe

The router performs seven independent fallthrough checks before it
touches `preventDefault`. All seven would have to pass — meaning the
link has to be a same-origin http(s) URL, with no modifier keys, no
`target` other than `_self`, no `download` attribute, no
`data-no-spa`, and clicked with the primary mouse button. Anything
else hits the browser path, identical to pre-v0.22 behavior.

### Migration note

If you relied on the old default (only explicit `data-mandu-link`
gets SPA behavior), the migration is one line in `mandu.config.ts`:

```diff
  export default {
+   spa: false,
  } satisfies ManduConfig;
```

For new code, leave `spa` unset (or `true`) and remove your
`data-mandu-link` attributes — plain `<a href>` now does the right
thing.

## Troubleshooting the inline SPA helper (issue #220)

`hydration: "none"` projects (docs, blogs, marketing sites) use a tiny
inline IIFE — `SPA_NAV_HELPER_BODY` — injected into every SSR
`<head>` to upgrade `<a href>` clicks into `pushState` + `fetch` +
body-swap navigations. Since there is no bundle loaded, there is also
no developer console for this code to write to by default.

As of **v0.28+** (issue #220) the helper instruments every branch of
the swap pipeline:

**Success path (`console.debug`):**

```
[mandu-spa-nav] swap target container: main
[mandu-spa-nav] swapped to /about in 18ms (container=main)
```

**Failure path (`console.warn`) — every one of these triggers a full
browser navigation via `location.href = url` so the user is never
stuck on stale content:**

```
[mandu-spa-nav] falling back to full navigation: fetch responded 500 /about
[mandu-spa-nav] falling back to full navigation: non-HTML response (application/json) /api/data
[mandu-spa-nav] falling back to full navigation: DOMParser threw: ... /about
[mandu-spa-nav] falling back to full navigation: DOMParser returned parsererror /about
[mandu-spa-nav] falling back to full navigation: no swap container matched (<main>/#root/<body>) /about
[mandu-spa-nav] falling back to full navigation: innerHTML assignment threw: ... /about
[mandu-spa-nav] falling back to full navigation: fetch rejected: ... /about
[mandu-spa-nav] falling back to full navigation: pushState threw: ... /about
```

### "My URL changes but the page content stays the same"

Open DevTools → Console. If you see a `[mandu-spa-nav]` warning you
now have the root cause. Common reasons:

1. **No `<main>`, no `#root`, no `<body>`**: the helper picks the
   first match in that order. Custom layouts must provide at least
   one of them. Adding `<main>` to your page layout is the
   recommended fix — it also matches the ARIA landmark.
2. **Scripts don't execute after swap**: the helper extracts all
   `<script>` elements from the new container and re-creates them
   via `document.createElement("script")` so they fire. If your
   scripts rely on `DOMContentLoaded` (already fired) you will need
   to also listen for the new `__MANDU_SPA_NAV__` custom event.
3. **Non-HTML response**: the server returned JSON or a redirect
   without an HTML `Content-Type`. Hard-nav fallback kicks in.

### Re-hydration hook: `__MANDU_SPA_NAV__`

After every successful swap the helper dispatches a custom event on
`window`:

```ts
window.addEventListener("__MANDU_SPA_NAV__", (event) => {
  const { url, durationMs, container } = (event as CustomEvent).detail;
  // re-init your third-party widgets here
  console.log(`navigated to ${url} (${durationMs}ms, swapped ${container})`);
});
```

The detail payload:

| Field         | Type     | Value                                 |
|---------------|----------|---------------------------------------|
| `url`         | string   | the new path (pathname + search + hash) |
| `durationMs`  | number   | wall-clock time fetch→swap in ms      |
| `container`   | string   | `"main"` \| `"#root"` \| `"body"`     |

This event is **not** dispatched on the fallback path — if the user
hits a full navigation, the fresh page load will naturally re-run all
your scripts and you don't need re-hydration.

### View Transitions integration

When `document.startViewTransition` is available (Chrome/Edge ≥ 111,
Safari 18.2+), the swap is wrapped in a transition callback so it
composes with the `@view-transition { navigation: auto }` rule Mandu
already emits. If the transition API throws, the helper falls back
to a synchronous swap *and* logs a warning — no navigation is lost.

## Known limits

### Prefetch doesn't compose with CSP `script-src`

The prefetch helper is an **inline script**, so if you ship a strict
Content-Security-Policy you need either:

- `'unsafe-inline'` (not recommended), or
- A nonce that Mandu's SSR layer attaches (currently only the Fast
  Refresh dev preamble receives a nonce; prefetch CSP wiring is
  tracked as a follow-up).

If CSP conflicts are blocking you, the safe workaround today is to
set `prefetch: false` in `mandu.config.ts` and use Mandu's explicit
`prefetch()` API from `@mandujs/core/client` in code.

### View transitions and fixed-position elements

Browsers without a `view-transition-name` on fixed-position elements
(headers, sidebars) will crossfade them along with the rest of the
page — which can look janky. If you notice a header flicker:

```css
/* app.css or a layout stylesheet */
header {
  view-transition-name: site-header;
}
```

Mandu does not emit these rules automatically — they're
application-specific. See the
[MDN docs on view-transition-name](https://developer.mozilla.org/en-US/docs/Web/CSS/view-transition-name)
for the full taxonomy.

## Performance characteristics

Measured on a 1-page "Hello World" SSR response (dev mode, Bun 1.3.12,
Windows 10 + local Chrome 128):

| Metric                       | Before #192 | After #192 | Delta  |
|------------------------------|-------------|------------|--------|
| HTML response bytes          | 1 486       | 2 041      | +555 B |
| HTML response bytes (gzip)   | 748         | 1 011      | +263 B |
| TTFB                         | 4 ms        | 4 ms       | ±0 ms  |
| First hover → prefetch fire  | n/a         | ~2 ms       | new   |
| Prefetch → cache hit window  | n/a         | ~20 s default (browser) | new |

The `+555 B` uncompressed cost is paid once per SSR response. In
production with gzip/brotli the effective overhead is under 300
bytes — a rounding error next to a typical `index.html` that already
ships multiple KB of meta tags.

## Related

- **Issue #192** — CSS View Transitions + hover prefetch (origin thread)
- **Issue #193** — opt-in → opt-out SPA nav reversal (shipped in v0.22)
- **`@mandujs/core/client` prefetch API** — programmatic prefetch
  for route IDs (lower-level; wires through the router)
- **`Bun.CookieMap`** — unrelated but same area — Bun-native cookie
  helpers we use alongside SSR for auth flows

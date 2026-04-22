---
"@mandujs/core": patch
"@mandujs/cli": patch
---

fix(core,cli): #232 follow-up — eager page-component registration

The initial #232 fix (dev server bypasses the prerender cache) unmasked
a latent lazy-registration race: `registerPageHandler` /
`registerPageLoader` only install thunks at HMR reload time; the actual
page component is registered inside `routeComponents` when the first
request triggers `loadPageData`. If the HMR-broadcast reload hits any
code path that reaches `createDefaultAppFactory` before the lazy
import completes, the fallback "404 - Route Not Found" renders even
for perfectly valid routes (e.g. `[lang]/page.tsx` with a slot module).

Previously, the prerender cache short-circuit masked this path — users
never saw the 404 because the prerendered HTML was served instead.

Fix: a new `prewarmPageRoutes(registry?)` public helper iterates every
registered pageHandler / pageLoader and drives it through the same
import + `registerRouteComponent` that the first request would. The
CLI dev command invokes it at every registration site:

- initial boot (`mandu dev`)
- SSR change rebuild
- API change re-register
- route manifest watcher
- full `restartDevServer`

Prewarm failures log a per-route warning but do not block the reload —
a single broken file stays broken while healthy routes keep serving.
Production `mandu start` is unaffected (no HMR, no reload race).

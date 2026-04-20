---
"@mandujs/ate": patch
---

fix(ate): #224 ssr-verify spec no longer crashes on redirect routes

The `mandu test:auto` generated `ssr-verify` Playwright spec called
`page.content()` immediately after `page.goto(url)`. On any route that
performs a page-level redirect (meta-refresh, `return redirect(...)`,
`/` → `/<defaultLocale>`, etc.) this raised:

> Error: page.content: Unable to retrieve content because the page is
> navigating and changing the content.

Three changes:

1. **`waitUntil: "networkidle"`** — all page-oriented spec templates
   (`route-smoke`, `ssr-verify`, `island-hydration`) now wait for network
   idle on `goto`, so downstream inspections see the final settled page.
2. **Redirect detection** — the extractor now flags a route as
   `isRedirect` when the page source emits
   `<meta httpEquiv="refresh" ...>` or returns `redirect(...)`. The
   `ssr-verify` spec for redirect routes skips `page.content()` and the
   `<!DOCTYPE html>` / `data-mandu-island` assertions, instead asserting
   that navigation settled to a different URL. `island-hydration` specs
   are not emitted for redirect origins (the page navigates away before
   any island could hydrate).
3. **IPv4 baseURL fallback (#223)** — the emitted specs and the
   generated `playwright.config.ts` now default to
   `http://127.0.0.1:3333` instead of `http://localhost:3333`, avoiding
   Windows Node fetch failures when IPv6 `::1` resolves first but the
   dev server binds IPv4 only.

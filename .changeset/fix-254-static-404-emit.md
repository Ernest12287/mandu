---
"@mandujs/core": patch
---

fix(#254): emit `dist/404.html` from `app/not-found.tsx` during static build

Static hosts (Vercel, Netlify, Cloudflare Pages, Firebase Hosting)
auto-serve `dist/404.html` for unmatched URLs. Mandu's
`build --static` previously left `app/not-found.tsx` invisible to
the static export, so visitors hit the platform's plain-text
default ("The page could not be found / NOT_FOUND") instead of the
framework's own 404 page.

The prerender step now:

1. Checks for `app/not-found.{tsx,ts,jsx,js}` at the project root.
2. Issues a multi-segment sentinel probe through the SSR pipeline so
   the registered not-found handler renders the page exactly the
   way it does at runtime.
3. Writes the 404-status response body to `<outDir>/404.html`.
4. Skips emit (with a clear warning) when a root-level catch-all
   route absorbs the probe — emitting the catch-all body as
   `404.html` would be wrong.

The `static-export` step copies the file through verbatim (it
already mirrors `.mandu/prerendered/` into `dist/`), so the
mandujs.com workaround (`scripts/postbuild-404.ts`) can be removed.

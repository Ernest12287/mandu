---
"@mandujs/cli": patch
"@mandujs/core": patch
---

fix(#247): Vercel adapter generates a deployable SSR artifact

- Bug 4: rename SSR function from `api/_mandu.ts` to `api/mandu.ts` — Vercel hides leading-underscore files in `/api` (Next.js `_app`/`_document` convention) so the previous filename was silently dropped from function detection.
- Bug 5: move `registerManifestHandlers` from `@mandujs/cli/util/handlers` to `@mandujs/core/runtime`. The CLI subpath has no `exports` map, so the generated SSR entry could not import it under strict resolution. Now exported from the public `@mandujs/core` surface — same package the entry already imports `startServer`/`generateManifest` from.

The Netlify adapter template was changed alongside since it had the same private-import smell. JIT prewarm's deep-specifier list was updated to point at `@mandujs/core/runtime` instead of the deleted `cli/util/handlers`.

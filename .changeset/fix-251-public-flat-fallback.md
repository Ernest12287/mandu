---
"@mandujs/core": patch
---

fix(#251): serve public/* assets at root URL in dev (parity with `mandu build --static`)

`mandu build --static` flattens `public/<file>` into the dist root, so
`/images/foo.webp` resolves in production. In dev the static handler
only mounted `/public/<file>`, leaving authors to choose between
`/public/...` (works in dev, also OK in prod via Vercel rewrite) and
`/...` (broken in dev, OK in prod). The mismatch surfaced as 404s on
prop-bound `<img src>` references that strip the `/public/` prefix.

The dev/prod static server now also serves `/<asset>.<ext>` from
`public/<asset>.<ext>` when the path has a recognised asset extension
(`.webp`, `.png`, `.css`, `.woff2`, …). If the file is missing, the
handler falls through to the router so route patterns like
`/api/foo.json` are not shadowed by the fallback.

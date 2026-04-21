---
"@mandujs/ate": patch
---

fix(ate): #226 SSR-verify is no longer satisfied by an empty body

The generated ssr-verify spec previously only asserted `<!DOCTYPE html>` /
`<html` presence — a route that rendered an empty `<body>` would pass.
Now the template also asserts:

1. **Body content is non-empty** — extracts inner body text after strip,
   requires length > 0.
2. **Semantic anchor present** — requires either `data-route-id=` (Mandu
   emits this on the outermost wrapper) OR a `<main>` landmark.

Combined, these rules make it structurally impossible for a broken /
empty SSR render to slip through.

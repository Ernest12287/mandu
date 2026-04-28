---
"@mandujs/cli": patch
---

fix(#246): Vercel adapter emits valid `vercel.json` and Bun-compatible SSR entry

- Drop invalid `functions[*].runtime: "nodejs20.x"` (Vercel rejects bare identifiers)
- Default to `@vercel/bun@1.0.0` community runtime — Mandu core uses Bun-only APIs
- Drop deprecated top-level `name` field (owned by Vercel project settings)
- Rewrite `api/_mandu.ts` entry to export Bun-style `{ fetch }` instead of Node `IncomingMessage`/`ServerResponse`
- Validate `runtime` as npm package spec; reject bare identifiers with a clear error

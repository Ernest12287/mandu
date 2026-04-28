---
"@mandujs/cli": minor
---

feat(#249): `mandu build --static` flat-export mode

`mandu build --static[=<dir>]` runs the normal build and then materializes a single host-ready directory shaped like the URL space — prerendered HTML at the root, client bundles preserved at `<dir>/.mandu/client/...` so the absolute URLs the prerender step already wrote into HTML resolve, and `public/` files merged at the root. Default output dir is `dist/`. Refuses to overwrite the project root or `.mandu/` itself, and fails loud if the build did not actually produce HTML or client bundles. Tests in `packages/cli/src/util/__tests__/static-export.test.ts`.

fix(#248): Vercel adapter pivots to static-only

The previous adapter scaffolded an SSR function targeting `@vercel/bun@1.0.0`, which is not a published Vercel runtime — every deploy failed at vercel.json validation with `The package "@vercel/bun" is not published on the npm registry`. None of the actually-published function runtimes (built-in Node, Edge, `@vercel/python`) can host Mandu's `startServer` because core uses Bun-only globals.

The adapter now generates a static-only `vercel.json` (`outputDirectory: "dist"`, `buildCommand: "bun run mandu build --static"`, no `functions`/`runtime`/SSR rewrites). `check()` warns when the manifest contains API routes that the static build will drop on the floor. The SSR entry template (`renderVercelFunctionEntry`) is removed; restore it once an official Vercel Bun function runtime ships.

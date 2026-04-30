---
"@mandujs/mcp": minor
---

feat(mcp/#250): `mandu.deploy.plan` + `mandu.deploy.compile` tools

Two MCP tools that expose the M1/M3 deploy-intent pipeline to AI
agents without going through the CLI:

- **`mandu.deploy.plan`** — runs the offline heuristic over the
  routes manifest and the existing intent cache. Returns a structured
  per-route diff (route_id, kind, runtime, previous_runtime,
  rationale, source) plus validation warnings. Default `apply: false`
  is read-only; agents review the diff and call again with
  `apply: true` to atomically write `.mandu/deploy.intent.json`.
  `reinfer: true` forces re-inference even on unchanged hashes.

- **`mandu.deploy.compile`** — compiles the manifest + cache into a
  concrete `vercel.json`. Returns the config object, per-route
  summary, and compile warnings (e.g. #248 runtime gaps). Read-only.
  Phase 1 supports `target: "vercel"` only.

Both tools share the same `@mandujs/core/deploy` engine the CLI uses,
so agents and humans see identical results. 8 new MCP tests cover the
default (read-only) path, apply, explicit override preservation,
empty-cache error path, and unknown-target rejection.

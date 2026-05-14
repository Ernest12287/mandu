---
"@mandujs/core": minor
"@mandujs/mcp": minor
---

Agent DevTools P0 cycle (plan 18): expose `mandu.devtools.context` MCP tool, expand the Agent Supervisor context pack with build/diagnose/diff signals, and align Kitchen UI tokens to the mandujs.com Stitch system.

- `@mandujs/core`: `AgentContextPack` now classifies `build-broken` (missing/stale `.mandu/manifest.json`, `manifest_freshness` diagnose error) and `boot-breaking` (`nested_internal_core`, `package_export_gaps`, `manifest_validation`) ahead of hydration/runtime errors. New optional inputs: `bundleManifest`, `diagnoseReport`, `changedFiles`. The `/__kitchen/api/agent-context` handler collects all three with fail-safe collectors and supports `?bundle=0&diagnose=0&diff=0` skip toggles for latency control. Kitchen UI CSS tokens swap to the Stitch palette (Peach `#FF8C66` / Dark Brown `#4A3222` / Cream `#FFFDF5`) with Pretendard + Nunito + Consolas, hard shadow on primary buttons.
- `@mandujs/mcp`: new `mandu.devtools.context` tool returns the full Agent Supervisor context pack in a single call so agents can self-orient without opening Kitchen. Three boolean toggles (`includeBundle`, `includeDiagnose`, `includeDiff`) mirror the HTTP query params. Backward-compatible underscore alias `mandu_devtools_context`. Requires `mandu dev` to be running.

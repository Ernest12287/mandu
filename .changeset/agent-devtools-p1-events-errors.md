---
"@mandujs/core": minor
---

Agent DevTools P1 cycle (plan 18): expose previously invisible eventBus categories and add a dedicated Errors panel with stack-signature grouping.

- New `/__kitchen/api/events` endpoint with `?type=` (one of `http|mcp|guard|build|cache|ws|ate|error`), `?severity=`, `?limit=` and `?stats=1` query params. The Activity panel now has filter chips for every category — `build` / `cache` / `ws` / `ate` events that the bus emits but the legacy panel never showed are surfaced with one click.
- New `/__kitchen/api/errors/grouped` endpoint plus a new "Errors" tab. Identical browser error signatures collapse into one row (`x5` count, first/last seen, affected sources, expandable stack frame). Grouping key is sha1 of `type | source | normalize(message)` where `normalize` strips numbers, UUIDs, and hex addresses so retry counts and request IDs don't fragment the same bug.

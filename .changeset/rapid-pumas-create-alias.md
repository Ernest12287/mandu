---
"@mandujs/cli": patch
---

Add `aliases` field to CommandRegistration so a single registration can be bound under multiple names. Use it to make `mandu create` a true alias of `mandu init` (closes #256 — docs advertised `mandu create` while only `init` was bound). Also makes `mandu g` actually dispatch to `mandu guard` — the `g` alias was previously documented in `--help` but never wired up.

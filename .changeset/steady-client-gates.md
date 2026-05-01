---
"@mandujs/core": patch
"@mandujs/cli": patch
---

Stabilize production hydration gates and client bundle output. Production builds now use explicit build modes, default client output resolves to `.mandu/client`, and the perf harness reports hydration failures without overwriting HTTP-derived metrics.

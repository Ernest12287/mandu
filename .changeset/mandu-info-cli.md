---
"@mandujs/cli": patch
---

feat(cli): ship `mandu info` — agent-friendly env + config + health dump

Replace the 87-line stub with a full 8-section snapshot command covering mandu
versions, runtime, project, config summary, routes, middleware, plugins, and
diagnose. Supports `--json` for issue reports and `--include <sections>` for
scoped output. Missing config is a non-crash path — the command is an inspector,
not a gate.

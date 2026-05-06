---
"@mandujs/cli": minor
---

Split `mandu init` and `mandu create` semantics, matching the npm/bun ecosystem convention. `mandu create <name>` is now the canonical new-folder scaffold path; `mandu init` (no positional) is a *retrofit* that drops Mandu structure into the current directory — `package.json` is merged (existing entries preserved unless `--force`) and `app/page.tsx` is created if absent.

The retrofit flow refuses to run on top of foreign frameworks (Next.js / Vite / Remix detected via config files or deps) and an existing Mandu project (`@mandujs/core` already in deps). For polyglot directories where partial Mandu structure exists, `--force` is required. `--dry-run` prints the planned changes without writing.

For one deprecation cycle, `mandu init <name>` continues to work — it prints a warning and forwards to `mandu create <name>`. The forwarding will be removed in a future major.

---
"@mandujs/core": minor
"@mandujs/cli": minor
"@mandujs/mcp": patch
---

refactor(brain): remove Ollama tier; cloud OAuth is the only non-template adapter

The local-LLM (Ollama) tier is gone. The brain resolver now resolves
in priority order **openai → anthropic → template**, and the
`adapter` config union no longer accepts `"ollama"`. The `ollama` npm
dependency is removed from `@mandujs/core`.

`BrainAdapterResolution` gains a `needsLogin: boolean` field so
interactive surfaces can detect "fell back to template because the
user has no token" vs "fell back because the user opted out". The new
`ensureBrainLogin()` helper in `@mandujs/cli` reads that signal and
prompts to run `mandu brain login --provider=openai` when needed.

`mandu brain status` surfaces the same hint inline. The MCP
`mandu.brain.status` tool exposes `needs_login` + `login_hint` so AI
agents can drive the login flow programmatically.

**Migration**: any `ManduConfig` block that set `brain.adapter = "ollama"`
or `brain.ollama.*` must be removed — the schema now rejects them.
Default behavior (omitted block) is unchanged: auto-resolves to the
best available cloud tier, falls back to template otherwise.

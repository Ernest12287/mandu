---
name: mandu-ai-chat-playground
version: 1.0.0
audience: Developers using `mandu ai chat` interactively
last_verified: 2026-04-19
phase: 14.2
---

# `mandu ai chat` — Playground Reference

The REPL exposes a small surface of slash commands for managing state
without leaving the terminal.

## Slash Commands

| Command | Behavior |
|---|---|
| `/help` | Print the command list (safe offline) |
| `/reset` | Clear conversation history (system prompt kept) |
| `/save <path>` | Dump history to JSON (schema v1) |
| `/load <path>` | Restore history from JSON |
| `/preset <name>` | Load `docs/prompts/<name>.md` as the system prompt |
| `/system <path>` | Load an arbitrary file as the system prompt |
| `/provider <name>` | Switch provider (claude / openai / gemini / local) |
| `/model <id>` | Override model for the current provider |
| `/quit` (`/exit`, `/bye`) | Graceful exit |

## History JSON Schema (v1)

```json
{
  "version": 1,
  "provider": "claude|openai|gemini|local",
  "model": "optional-model-id",
  "system": "optional system prompt text",
  "savedAt": "2026-04-19T10:22:13.000Z",
  "messages": [
    { "role": "user",      "content": "hello" },
    { "role": "assistant", "content": "hi back" }
  ]
}
```

The CLI rejects any file that doesn't match this shape with `CLI_E302`.
The in-memory scrollback is bounded to **100 turns**; older entries are
dropped when the limit is exceeded.

## Flags

| Flag | Default | Notes |
|---|---|---|
| `--provider` | `local` | One of: `claude`, `openai`, `gemini`, `local` |
| `--model` | provider-specific | See `PROVIDER_DEFAULT_MODEL` in `ai-client.ts` |
| `--system` | — | Absolute or CWD-relative file path |
| `--preset` | — | Name of a `docs/prompts/<name>.md` file |
| `--timeout` | 60000 ms | Per-stream wall-clock budget |
| `--help` | off | Prints help without touching the network |

Environment overrides:

- `MANDU_AI_TIMEOUT_MS` — raises the default stream budget (CI may want 180_000)
- `MANDU_LOCAL_BASE_URL` — hits an OpenAI-compatible server (Ollama, LM Studio)

## Security Notes

- API keys are **never** printed. Errors mask them as `sk-***`.
- Slash-command arguments are escaped: `/preset ../etc` is rejected by a
  strict alphanumeric allow-list before the file open.
- Non-UTF8 / NUL-containing input is rejected with `CLI_E308` so it
  never hits the adapter's HTTP body.

## Tips

- Open a second terminal and tail the history file while chatting:
  ```bash
  /save /tmp/history.json
  tail -f /tmp/history.json
  ```
- Use `/load` to resume a long-running thread after a disconnection —
  the file is self-describing (includes provider + model).
- Combine `/preset mandu-conventions` with `/model claude-sonnet-4-...`
  for repo-aware Q&A without leaving the terminal.

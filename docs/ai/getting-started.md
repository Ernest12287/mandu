---
name: mandu-ai-getting-started
version: 1.0.0
audience: Developers exploring LLM providers from the Mandu CLI
last_verified: 2026-04-19
phase: 14.2
---

# `mandu ai` — Getting Started

`mandu ai` is a terminal playground for streaming chat with Claude, OpenAI,
Gemini, or a local Ollama/LM-Studio runtime. It ships with two subcommands:

| Command | Purpose |
|---|---|
| `mandu ai chat` | Interactive REPL with streaming responses + slash commands |
| `mandu ai eval` | Non-interactive evaluator (runs one prompt, prints JSON) |

## Install

`mandu ai` is bundled with the main CLI — no extra install step.

```bash
bunx mandu ai --help
```

## First Run (Offline)

The `local` provider ships a deterministic echo responder that works with
**no API key**. Use it for smoke tests, CI, and demos:

```bash
mandu ai chat --provider=local
mandu ai eval --provider=local --prompt="hello"
```

The echo response is a stable transform of the input, so CI diff tests
will never flake.

## Hooking Up a Real Provider

Export the matching environment variable before launching `mandu ai`:

| Provider | Env var |
|---|---|
| Claude (Anthropic) | `MANDU_CLAUDE_API_KEY` |
| OpenAI | `MANDU_OPENAI_API_KEY` |
| Gemini (Google) | `MANDU_GEMINI_API_KEY` |
| local (Ollama, LM Studio) | optional — set `MANDU_LOCAL_BASE_URL=http://127.0.0.1:11434` |

> **Secrets are never logged.** If a request fails, the error message
> masks the key as `sk-***`. You can also store keys in `Bun.secrets`
> (OS keychain) — `mandu ai` reads it as a fallback when the env var
> is absent.

## Common Tasks

### Pick a provider per-session

```bash
mandu ai chat --provider=claude
mandu ai chat --provider=openai --model=gpt-4o
```

### Load a system prompt

```bash
# From a project-local doc:
mandu ai chat --preset=mandu-conventions

# From an arbitrary file:
mandu ai chat --system=./my-system.md
```

### Eval a prompt across providers

```bash
mandu ai eval \
  --prompt="Summarize Mandu in one paragraph." \
  --providers=local,claude,openai
```

The output is a JSON object ready to feed into `jq`, snapshot tests, or
a CI evaluator. Exit 0 when every provider succeeded; exit 1 if any
returned an error.

### Abort a streaming response

Hit **Ctrl+C** during an in-flight response. The stream disconnects
cleanly, the failed turn is dropped from history, and the REPL returns
to the prompt.

## Troubleshooting

| Code | Meaning | Fix |
|---|---|---|
| CLI_E300 | API key missing | Export the right `MANDU_*_API_KEY` |
| CLI_E301 | Stream failed | Check network / provider status |
| CLI_E302 | Malformed history | Regenerate with `/save` |
| CLI_E303 | Preset not found | Check `docs/prompts/<name>.md` |
| CLI_E307 | Timeout | Raise `MANDU_AI_TIMEOUT_MS` |

See also: [Chat Playground](./chat-playground.md) for slash commands.

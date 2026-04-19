# Project created

**Location**: `{{targetDir}}`

## Getting started

```bash
cd {{projectName}}{{installHint}}
bun run dev
```

### CLI execution reference

- `bun run dev` — recommended (local script)
- `bunx mandu dev` — alternative if `mandu` is not in PATH

## File structure

- `app/layout.tsx` — Root layout
- `app/page.tsx` — `http://localhost:3333/`
- `app/api/*/route.ts` — API endpoints
- `src/client/*` — Client layer
- `src/server/*` — Server layer
- `src/shared/contracts` — Contracts (client-safe)
- `src/shared/types` — Shared types
- `src/shared/utils/client` — Client-safe utils
- `src/shared/utils/server` — Server-only utils
- `src/shared/schema` — Server-only schemas
- `src/shared/env` — Server-only env{{cssLine}}{{uiLines}}

## AI agent integration

{{mcpLines}}
- `AGENTS.md` — Agent guide (specifies Bun usage)

## Claude Code skills

{{skillsLines}}

## Config integrity

{{lockfileLines}}

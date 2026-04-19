# CLI_E010 — Port `{{port}}` already in use

## What happened

{{message}}

## How to fix

- Pick a different port on the command line: `PORT=3334 bun run dev`
- Or set `server.port` in `mandu.config.ts`
- Or identify and stop the process currently bound to `{{port}}`:
  - macOS / Linux: `lsof -i :{{port}}`
  - Windows (PowerShell): `Get-NetTCPConnection -LocalPort {{port}}`

## Links

- [Dev server configuration](https://mandu.dev/docs/cli/dev)

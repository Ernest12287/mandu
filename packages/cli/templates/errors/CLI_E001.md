# CLI_E001 — Directory already exists

**Path**: `{{path}}`

## What happened

{{message}}

## How to fix

1. Choose a different project name: `mandu init <new-name>`
2. Or remove the existing directory first:
   - macOS / Linux: `rm -rf {{path}}`
   - Windows (PowerShell): `Remove-Item -Recurse -Force "{{path}}"`
3. Re-run `mandu init` once the path is free.

## Links

- [mandu init documentation](https://mandu.dev/docs/cli/init)

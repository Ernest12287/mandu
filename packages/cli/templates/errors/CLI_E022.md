# CLI_E022 — `{{count}}` architecture violation(s) found

## What happened

{{message}}

## How to fix

1. Review the violations listed above — each includes the offending file and the layer rule it broke.
2. Adjust imports so they flow toward lower-level layers (no upward dependencies).
3. If you need CI-friendly output for an AI agent, re-run with:
   ```bash
   MANDU_OUTPUT=agent mandu guard check
   ```

## Links

- [Guard presets reference](https://mandu.dev/docs/guard)
- [Layer architecture guide](https://mandu.dev/docs/architecture/layers)

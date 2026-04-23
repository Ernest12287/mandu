---
"@mandujs/core": minor
"@mandujs/cli": minor
"@mandujs/mcp": patch
---

feat(guard): #follow-up-E `mandu guard --type-aware` bridge

Wires `oxlint --type-aware` (tsgolint) into Mandu Guard as an opt-in
type-aware lint layer that runs after the architecture / layer check.

- **`@mandujs/core/guard/tsgolint-bridge`** — new module. Spawns
  `oxlint --type-aware --format=json` with `Bun.spawn`, translates each
  diagnostic into the existing `Violation` contract, and returns a
  `{ violations, summary, skipped? }` envelope. Graceful skip when the
  binary is absent (`node_modules/.bin/oxlint[.exe]` missing →
  `{ skipped: "oxlint-not-installed" }`). 60s wall-clock timeout
  (`MANDU_TSGOLINT_TIMEOUT_MS` env override for slow agents).

- **`ManduConfig.guard.typeAware`** — new optional config block.
  Fields: `rules?: string[]` (allowlist), `severity?: "off"|"warn"|"error"`,
  `configPath?: string`. Declaring the block flips the default to "on"
  for `mandu guard`; the CLI's `--no-type-aware` flag always wins.

- **`mandu guard --type-aware` / `--no-type-aware`** — CLI flags on
  `guard-arch`. Type-aware errors flip the exit code; warnings alone
  stay green (CI flag escalates warnings, matching the architecture
  pass). JSON output mode emits a secondary `{ typeAware }` JSON document.

- **`mandu_guard_check` MCP tool** — gains a `typeAware?: boolean`
  input field; response JSON mirrors the CLI shape via a new
  `typeAware` field (skip reason, summary, violations).

No new runtime dependencies — `oxlint` stays a user-side dev dep.
Existing architecture-layer Guard tests unchanged (272 pass). Adds
21 new tests (15 bridge + 6 CLI) covering rule-id normalization,
severity mapping, diagnostic translation, binary resolution,
graceful skip, severity=off short-circuit, filter allowlist, and
CLI exit-code gating.

---
"@mandujs/ate": patch
---

fix(ate/publish): #230 include schemas/ in the published tarball

`@mandujs/ate@0.21.0`–`0.24.0` shipped without the `schemas/`
directory because `packages/ate/package.json` `files` field only
listed `src/**/*` and `prompts/**/*`. `src/index.ts` imports
`../schemas/failure.v1`, so every consumer (including the MCP
server at 0.25.0–0.27.0) crashed at module load.

Fixes:
- Add `schemas/**/*` to the `files` allow-list.
- New regression guard test (`tests/package-integrity.test.ts`) runs
  `bun pm pack --dry-run` and asserts every runtime-required directory
  (schemas/, src/, prompts/, mutation operators, oracle queue) is
  present in the tarball. Prevents this class of regression.

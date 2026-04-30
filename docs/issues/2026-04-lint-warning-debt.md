# 2026-04 Lint Warning Debt

## Snapshot

Checked on 2026-04-30 with:

```bash
bunx oxlint packages/ -f json
bun run lint:type-aware:debt -f json
```

Current baseline: 302 warnings, 0 errors.

Type-aware gate baseline: 0 warnings, 0 errors.

Type-aware debt report baseline: 1569 warnings, 0 errors. The default
`bun run lint:type-aware` command now filters broad advisory debt and keeps
high-signal type-aware rules active. Use `bun run lint:type-aware:debt` when
working through the larger cleanup backlog.

## Distribution

| Rule | Count | Notes |
| --- | ---: | --- |
| `eslint(no-unused-vars)` | 205 | Mostly unused imports, unused destructured values, and stale helper variables. Lowest behavioral risk when fixed in small batches. |
| `typescript-eslint(consistent-type-imports)` | 41 | Inline `import("...").Type` annotations should become top-level `import type` aliases. Keep an eye on circular import risk in runtime files. |
| `eslint-plugin-unicorn(require-module-specifiers)` | 32 | Mostly empty template barrel files using `export {};`. Needs a consistent template convention rather than one-off edits. |
| `eslint-plugin-unicorn(prefer-add-event-listener)` | 13 | Event handler assignment style. Moderate risk in EventSource and browser lifecycle code; fix with targeted tests. |
| `eslint-plugin-unicorn(no-array-reverse)` | 11 | Replace mutating `reverse()` after `sort()` with `toReversed()` or explicit copy. Low risk but check runtime target support. |

Completed high-signal cleanup on 2026-04-30:

- `require-post-message-target-origin`: 2 -> 0. The remaining call sites were Worker `postMessage` calls, where `targetOrigin` is not part of the API; false positives are now documented inline.
- `preserve-caught-error`: 1 -> 0. The wrapped deploy-cache error now preserves the original error as `cause`.
- `no-unmodified-loop-condition`: 1 -> 0. The bundler stress test now uses an explicit break condition.
- `no-unneeded-ternary`: 1 -> 0. Registry follow mode now uses a direct boolean expression.
- `no-new`: 1 -> 0. Time zone validation now calls `Intl.DateTimeFormat` without an unused constructed value.
- `no-extraneous-class`: 1 -> 0. The Bun SQL test double is now a constructable function instead of a static-only class.

Completed first `packages/core` cleanup batch on 2026-04-30:

- `packages/core/src/guard/healing.ts`, `packages/core/src/guard/suggestions.ts`, and `packages/core/src/contract/define.ts`: targeted lint warnings are now 0.
- `packages/core/src/runtime/server.ts`: removed unused imports and converted inline type imports; targeted lint warnings are now 0.
- Baseline moved from 352 to 302 warnings while keeping `bun run typecheck`, `bun run lint`, `bun run lint:type-aware`, and related core tests green.

Completed type-aware gate cleanup on 2026-04-30:

- `packages/core/src/a11y/run-audit.ts`: fixed the remaining `await-thenable` finding by typing DOM cleanup as `void | Promise<void>`.
- Added `scripts/lint-type-aware.ts` so `bun run lint:type-aware` is a focused high-signal gate with 0 warnings.
- Added `bun run lint:type-aware:debt` for the full advisory type-aware backlog.

## Package Hotspots

| Package | Count |
| --- | ---: |
| `packages/core` | 150 |
| `packages/cli` | 79 |
| `packages/mcp` | 37 |
| `packages/ate` | 25 |
| `packages/edge` | 8 |
| `packages/skills` | 2 |
| `packages/playground-runner` | 1 |

Top files by warning count:

| File | Count | Main issue |
| --- | ---: | --- |
| `packages/core/src/index.ts` | 13 | Public barrel exports/import hygiene. |
| `packages/core/src/devtools/ai/mcp-connector.ts` | 6 | Browser/event style cleanup. |
| `packages/cli/templates/realtime-chat/src/client/features/chat/chat-api.ts` | 6 | Event handler assignment style. |
| `packages/mcp/src/tools/spec.ts` | 6 | Unused imports. |
| `packages/mcp/src/tools/seo.ts` | 6 | Unused imports/locals. |
| `packages/cli/src/commands/build.ts` | 5 | Import/type cleanup. |
| `packages/core/src/content/loaders/glob.ts` | 5 | Unused locals/imports. |
| `packages/ate/__tests__/e2e-runner.test.ts` | 5 | Inline type imports. |
| `packages/ate/src/dep-graph.ts` | 5 | Import/type cleanup. |
| `packages/mcp/src/server.ts` | 4 | Unused imports. |
| `packages/core/src/guard/semantic-slots.ts` | 4 | Unused imports/parameters. |

## Cleanup Order

1. Done: fix the 7 high-signal warnings first.
   - Verified with targeted lint JSON, targeted tests, `bun run typecheck`, and `bun run lint`.

2. In progress: clean `packages/core` unused imports/locals in batches by subsystem.
   - Done: `guard/healing`, `guard/suggestions`, `contract/define`, and `runtime/server.ts`.
   - Next: `index.ts`, `devtools/ai/mcp-connector.ts`, `content/loaders/glob.ts`, and `guard/semantic-slots.ts`.
   - Run `bun run typecheck` after each batch.

3. Normalize type-only imports.
   - Started in `runtime/server.ts`.
   - Convert inline `import("...").Type` annotations into explicit `import type`.
   - Avoid moving value imports across module boundaries.

4. Decide the template empty-barrel convention once.
   - Either remove empty barrel files from generated templates, or use a lint-accepted module marker consistently.
   - Verify with `bun run test:smoke`.

5. Fix browser event-handler style warnings.
   - Use `addEventListener` / `removeEventListener` where lifecycle cleanup is clear.
   - Run affected client/template tests.

## Gates

Keep the current advisory lint policy until the count is materially lower:

```bash
bun run lint
bun run lint:type-aware
bun run lint:type-aware:debt
```

When the warning count is under 50, consider adding `--max-warnings=0` for selected rules before making all warnings fatal.

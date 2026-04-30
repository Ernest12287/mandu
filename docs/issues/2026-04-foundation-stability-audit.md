# 2026-04 Mandu Foundation Stability Audit

## Verdict

Mandu has a strong foundation in structure, package separation, Bun-first tooling, and test investment. The initial audit found red P0 verification gates; this document now tracks the fixes that brought those gates back to green.

The first stabilization pass is complete: P0 verification gates are green and the P1 foundation items below are closed. Remaining work should move to warning debt, release rehearsal, and feature-specific hardening rather than basic foundation repair.

## Evidence Snapshot

Checked on 2026-04-30 with Bun 1.3.12.

| Check | Result | Notes |
| --- | --- | --- |
| `bun run typecheck` | Pass | Strict TypeScript baseline is intact. |
| `bun run lint` | Pass with warnings | 302 warnings; warnings do not fail the gate. |
| `bun run lint:type-aware` | Pass | Focused runtime-source type-aware gate; 0 warnings and `no-floating-promises` remains clean. |
| `bun run lint:type-aware:debt` | Pass with warnings | Full advisory type-aware backlog remains available separately; 1569 warnings. |
| `bun run test:core` | Pass | Fixed OpenAPI fixture dependency resolution and isolated race-prone bundler tests. |
| `bun run test:cli` | Pass | Fixed stale output assertion and registry mock leakage. |
| `bun run test:mcp` | Pass | 278 tests passed. |
| `bun run test:ate` | Pass | 546 tests passed. |
| `bun test packages/ate/__tests__` | Pass | Included in the root ATE script. |
| `bun test packages/edge/__tests__` | Pass | Included in the root package test script. |
| `bun test packages/skills/src` | Pass | Included in the root package test script. |
| `bun test packages/playground-runner/tests` | Pass | Included in the root package test script. |
| `bun run test:packages` | Pass | Core, CLI, MCP, ATE, Edge, Skills, and Playground Runner all pass. |
| `bun run test:smoke` | Pass | Template install path restored. |
| `bun run check:publish` | Pass | Check now covers all publishable packages, tarball internal dependency drift, and export-map wildcard/target regressions. |
| `bun run publish:dry` | Pass | Dry-run now validates package tarballs even when the current versions already exist on npm. |

## P0 Stabilization Items

- [x] Fix template smoke install failure.
  - Original issue: CLI templates used `lefthook ^1.14.0`, while the root project uses `^1.11.0` and smoke install could not resolve `^1.14.0`.
  - Scope: `packages/cli/templates/*/package.json`, generated template manifest if needed.
  - Verification: `bun run test:smoke`.

- [x] Fix core OpenAPI fixture dependency resolution.
  - Original issue: temp contract modules importing `zod` failed to load under Bun isolated linker, causing empty OpenAPI paths.
  - Scope: `packages/core/src/openapi/generator.ts` and/or OpenAPI test fixture setup.
  - Verification: `bun test packages/core/src/openapi/openapi.test.ts packages/core/tests/server/openapi-endpoint.test.ts`.

- [x] Fix core bundler fixture dependency resolution.
  - Original issue: temp projects with islands failed to resolve `react`, `react-dom`, and `react-refresh` during shared bundle builds.
  - Scope: bundler resolver setup or temp project fixture setup.
  - Verification: `bun test packages/core/tests/bundler/dev-common-dir.test.ts`.

- [x] Fix CLI test failures.
  - Original issues: `mandu info` assertion expected old colon output; `main.test.ts` registry mock leaked into unrelated command registry tests.
  - Scope: CLI test expectations and mock isolation.
  - Verification: `bun run test:cli`.

- [x] Harden publish gate.
  - Original issues: publish workflow skipped checks with `--skip-check`; pre-publish check still inspected `bun.lockb`; package consistency checks omitted `ate`, `edge`, and `skills`.
  - Scope: `.github/workflows/publish.yml`, `scripts/pre-publish-check.ts`.
  - Verification: `bun run check:publish` plus a dry publish path.

## P1 Foundation Items

- [x] Expand root test coverage scripts.
  - Add `test:edge`, `test:skills`, and `test:playground-runner`.
  - Include `packages/ate/__tests__` in the ATE test script.
  - Update CI quality matrix to run the same package coverage as local scripts.

- [x] Decide lint policy.
  - Either clean the 359 warnings and fail on warnings, or explicitly document that warnings are advisory.
  - Fix type-aware lint if it is intended to become a gate.
  - Decision: `lint:type-aware` now runs against runtime package sources only, excludes tests/templates, and treats noisy type-aware rules as advisory warnings. `lint:type-aware:full` remains available for the full package tree report.

- [x] Clear type-aware floating promise warnings.
  - Original issue: `typescript/no-floating-promises` reported 40 runtime-source call sites across CLI shutdown paths, client navigation/prefetch, watchers, SSE streams, and server teardown.
  - Fix: await callbacks and stream cancellation where ordering matters; explicitly mark intentional fire-and-forget cleanup/navigation with `void`.
  - Verification: `bun run lint:type-aware` reports 0 `no-floating-promises` warnings.

- [x] Narrow `@mandujs/core` public API surface before v1.
  - Current issue: wildcard export (`"./*": "./src/*"`) makes internal files public.
  - Fix: removed the wildcard export and replaced it with explicit stable subpaths for runtime, client, middleware, resource/db migration integration, testing helpers, and documented package surfaces.
  - Guardrail: `bun run check:publish` now fails if `@mandujs/core` reintroduces `exports["./*"]` or any package export points at a missing file.

- [x] Refresh docs and badges.
  - README test badge is stale.
  - Korean README Bun prerequisite is stale relative to `engines.bun >=1.3.12`.
  - Draft/TODO docs should be clearly marked or moved out of primary docs.
  - Fix: replaced static README test counts with script-based package-test status, aligned Bun version notes to 1.3.12+, filled the primary `defineResource()` custom-validator TODO, and labelled linked resource draft docs as draft from official pages.

- [x] Clarify playground runner production status.
  - `CloudflareSandboxAdapter` still contains explicit live SDK TODOs.
  - Keep private/scaffold wording until live wiring is complete.
  - Fix: package metadata, adapter comments, README, and deployment guide now describe the Cloudflare path as a scaffold until SDK wiring is complete; local mock/Docker paths remain documented separately.

## Stabilization Order

1. Restore smoke install path.
2. Restore core OpenAPI and bundler tests.
3. Restore CLI tests.
4. Make root package tests and CI reflect all maintained packages.
5. Harden publish checks.
6. Clean lint/type-aware lint policy.
7. Reduce public API drift before v1.

## Follow-up Work

- Lint warning debt is tracked in `docs/issues/2026-04-lint-warning-debt.md`; the default `lint:type-aware` gate is now 0 warnings, while the full advisory type-aware backlog is available as `lint:type-aware:debt`.
- Release rehearsal is no longer blocked by already-published versions; `publish:dry` still runs package validation.

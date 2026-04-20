---
"@mandujs/ate": minor
"@mandujs/mcp": minor
---

feat(ate,mcp): Phase A.1 — `mandu_ate_context` + 5-kind extractor expansion

First deliverable of the agent-native ATE v2 roadmap
(`docs/ate/roadmap-v2-agent-native.md` §7 Phase A.1).

**ATE extractor** now scans seven node kinds (was route-only): `route`,
`filling`, `slot`, `island`, `action`, `form`, `modal`. `InteractionNode`
stays backwards compatible — existing route-only consumers keep working.
Also ingests `generateStaticParams` array literals statically (for the
Phase B boundary probe) and surfaces contract `examples` from
`.contract.ts` files.

**New `mandu_ate_context` MCP tool** (`scope: project | route | filling
| contract`, optional `id` / `route` arg). Returns a single JSON blob
containing route metadata + contract + middleware chain + guard preset
+ suggested `[data-route-id]` selectors + fixture recommendations +
existing specs + related routes. This is the context an agent reads
*before* writing a test. Snake_case name per roadmap §11 decision 4.

**Existing-spec indexer** (`spec-indexer.ts`) fast-globs
`tests/**/*.spec.ts` + `packages/**/tests/**/*.test.ts`, classifies each
file as `user-written` vs `ate-generated`, resolves coverage targets via
`@ate-covers` comments OR static import resolution, and attaches
last-run status from `.mandu/ate-last-run.json` when present.

Acceptance: integration test loads `demo/auth-starter/` and asserts the
returned context contains the signup route, csrf + session middleware,
recommended `createTestSession` + `createTestDb` + `testFilling`
fixtures, `[data-route-id=api-signup]` selector, and the UI entry-point
sibling.

---
"@mandujs/ate": minor
"@mandujs/mcp": minor
---

feat(ate,mcp): Phase A.2 — structured diagnostics, flake detection, artifacts, graph freshness

Ships ATE v2 Phase A.2 per `docs/ate/roadmap-v2-agent-native.md` §7 and the 2026-04-21 senior-grade extension block:

- `failure.v1` Zod schema + TypeScript type (`FailureV1`) with 8 discriminated kinds: `selector_drift`, `contract_mismatch`, `redirect_unexpected`, `hydration_timeout`, `rate_limit_exceeded`, `csrf_invalid`, `fixture_missing`, `semantic_divergence`. Every failure carries `flakeScore`, `lastPassedAt`, `graphVersion`, and `trace: { path?, screenshot?, dom? }`.
- `runSpec()` — unified spec runner that auto-detects Playwright vs bun:test from the path, forwards `shard: { current, total }` (Playwright `--shard=c/t`, bun hash partition), captures trace/screenshot/dom artifacts into `.mandu/ate-artifacts/<runId>/` before they can be garbage-collected, and translates raw runner output into deterministic `failure.v1` JSON (Playwright error objects are translated, not pass-through).
- Deterministic selector-drift auto-heal (`autoHeal`) — similarity = 0.5·text + 0.3·role + 0.2·DOM-proximity. Threshold precedence: explicit arg → `.mandu/config.json` → `MANDU_ATE_AUTO_HEAL_THRESHOLD` env → 0.75 default. Dry-run only; `applyAutoHeal()` is a separate, opt-in call.
- Flake detector — `.mandu/ate-run-history.jsonl` append-only log, rolling pass/fail transition score over the last `windowSize` runs. Alternating PFPF scores 1.0; pure PPPPP and pure FFFFF both score 0 (broken ≠ flaky). Auto-prune amortized at 10k entries.
- Artifact store — `.mandu/ate-artifacts/<runId>/`, keep-last-N policy (default 10, override via `MANDU_ATE_ARTIFACT_KEEP`).
- `graphVersion` freshness signal — `sha256(sorted routeIds + sorted contractIds + extractor version)` stamped on every context response and every failure payload. Agent cache invalidation key.
- `mandu_ate_run` MCP tool — `{ repoRoot, spec, headed?, trace?, shard? }` → `RunResult` (validated against `failureV1Schema` at the MCP boundary).
- `mandu_ate_flakes` MCP tool — `{ repoRoot, windowSize?, minScore? }` → `{ flakyTests: Array<{ specPath, flakeScore, lastRuns, lastPassedAt }> }`.

Resolves #229 (heal step returned empty suggestions — selector-drift now produces ranked deterministic candidates with confidence scores). 28 new tests across ate + mcp, zero runtime dependencies added.

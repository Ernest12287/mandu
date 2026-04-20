---
"@mandujs/ate": minor
"@mandujs/mcp": minor
"@mandujs/cli": patch
---

Phase B — boundary probe + memory + impact v2 + coverage

Ships ATE v2 Phase B (docs/ate/phase-b-spec.md):

- `mandu_ate_boundary_probe`: Zod contract → deterministic boundary set.
  18 type mappings (string/number/boolean/array/object/enum/union/literal
  plus min/max/email/uuid/regex/int/optional/nullable/nullish) —
  `expectedStatus` derived from contract response schema (400/422 for
  invalid, 200/201 for valid), depth-1 default with max 3,
  category+value dedup.
- `mandu_ate_recall` + `mandu_ate_remember`: append-only
  `.mandu/ate-memory.jsonl`. 7 event kinds: intent_history,
  rejected_spec, accepted_healing, rejected_healing,
  prompt_version_drift, boundary_gap_filled, coverage_snapshot.
  Substring + token-overlap scoring; auto-rotate at 10 MB to
  `.mandu/ate-memory.<ts>.jsonl.bak`. Auto-record hooks on
  `mandu_ate_save` (intent_history), `applyAutoHeal`
  (accepted_healing), and first-of-day `mandu_ate_context`
  (coverage_snapshot).
- `mandu_ate_impact` v2: git diff classification (additive / breaking /
  renaming via Levenshtein ≥ 0.8), affected spec/contract resolution,
  suggestion list keyed to re_run / heal / regenerate /
  add_boundary_test. Supports `since: "HEAD~1" | "staged" | "working"`.
  v1 output fields preserved for backwards compatibility.
  `mandu ate watch` CLI (fs.watch + 1 s debounce) streams impact v2 on
  working-tree changes.
- `mandu_ate_coverage`: route × contract × invariant matrix.
  `withBoundaryCoverage` / `withPartialBoundary` / `withNoBoundary`
  derived from boundary-probe presence in covering specs; invariant
  detection for csrf / rate_limit / session / auth / i18n;
  severity-ranked `topGaps` (high / medium / low).
- Prompt catalog +3: `property_based.v1`, `contract_shape.v1`,
  `guard_security.v1`. 12+ new `@ate-exemplar:` tags across
  `packages/core/tests/**` and `packages/ate/tests/exemplar-sources/`.
- `mandu ate memory clear` / `mandu ate memory stats` CLI subcommands.

Tests: +94 ate (429 → 523) + +10 mcp (194 → 204) + +3 cli.
`NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` clean across
all 7 packages.

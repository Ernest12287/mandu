---
"@mandujs/core": minor
"@mandujs/ate": minor
"@mandujs/mcp": minor
"@mandujs/cli": patch
---

feat(core,ate,mcp,cli): Phase C — primitives + mutation + RPC + oracle

Ships ATE v2 Phase C (docs/ate/phase-c-spec.md, 364-line spec):

- 5 Mandu-specific assertion primitives in @mandujs/core/testing:
  expectContract(strict/loose/drift-tolerant), expectNavigation,
  waitForIsland (data-hydrated polling), assertStreamBoundary
  (<!--$--> marker count + shell budget), expectSemantic
  (agent-delegated, CI non-blocking).
- 9 contract-semantic mutation operators (remove_required_field,
  narrow_type, widen_enum, flip_nullable, rename_field,
  swap_sibling_type, skip_middleware, early_return,
  bypass_validation). runner writes tmpdir, kills/survives/timeout
  classification. mutationScore + severity report via
  mandu_ate_mutate + mandu_ate_mutation_report.
- RPC parity: defineRpc extractor emits rpc_procedure nodes,
  context scope "rpc" with dot-notation id, boundary probe works
  automatically on input schemas.
- Oracle queue: .mandu/ate-oracle-queue.jsonl, mandu_ate_oracle_pending /
  verdict / replay. Semantic judgments deferred to agent session,
  deterministic CI never blocked. promoteVerdicts regresses past
  fails on next run.
- Prompt catalog +3: island_hydration, streaming_ssr, rpc_procedure.

Test counts: ate 575 / mcp 220. Typecheck clean across 7 packages.
ATE v2 core surface complete.

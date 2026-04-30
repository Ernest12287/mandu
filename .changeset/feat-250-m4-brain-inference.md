---
"@mandujs/core": minor
"@mandujs/cli": minor
"@mandujs/mcp": minor
---

feat(#250 M4): brain-validated deploy intent inference

`mandu deploy:plan --use-brain` (and the MCP `mandu.deploy.plan`
tool with `use_brain: true`) wraps the offline heuristic with the
OAuth-backed brain adapter. The brain confirms or refines each
route's intent without ever blocking the pipeline:

**Wrap-not-replace shape**
- Heuristic runs first (cost cap: ~80% of routes correct, $0).
- Brain weighs in on the same context and writes its own JSON.
- Output is parsed → Zod-validated → re-checked against route shape
  (`isStaticIntentValidFor`). Any failure falls back to heuristic
  with a rationale prefix that explains why.

**Failure modes (all silent fall-back)**
- LLM throws (network, auth, rate limit) — heuristic survives.
- LLM returns empty / non-JSON — heuristic survives.
- LLM returns JSON that fails the Zod schema — heuristic survives.
- LLM returns `runtime: "static"` on a dynamic page without
  `generateStaticParams` — heuristic survives.

**Surfacing the brain status**
- CLI: `🧠 Using brain (openai) to refine heuristic intents.` plus
  a clear "Run `mandu brain login --provider=openai`" hint when
  `--use-brain` is passed without a token.
- MCP: response carries `brain_status` (`used:openai`,
  `unavailable:needs_login`, `unavailable:opted_out`,
  `not_requested`) so agents can drive the login flow programmatically.

**New core export**: `inferDeployIntentWithBrain({ adapter })` —
the same wrapper kitchen / future MCP surfaces can plug in.

9 brain inferer tests cover happy path, partial-output merging,
fenced-JSON stripping, every fallback class, and `failOnError`
propagation. CLI and MCP gain integration tests for the
no-token / brain-active branches.

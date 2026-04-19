---
phase: 14.3
track: Agent G
status: Shipped
audience: AI agents, orchestrators, plugin authors
last_verified: 2026-04-19
bun_version: 1.3.12
depends_on:
  - packages/skills/src/loop-closure/
  - packages/mcp/src/tools/loop-close.ts
---

# Loop Closure — Detector / Emitter Framework

A "loop closure" detector recognizes stall patterns in agent output (stdout/stderr + exit code) and emits a structured `nextPrompt` that a human or orchestrator can feed back into the agent.

The framework lives in [`packages/skills/src/loop-closure/`](../../packages/skills/src/loop-closure/) and is exposed as:

- Library: `@mandujs/skills/loop-closure` (`closeLoop()`, detectors, emitter)
- MCP tool: `mandu.loop.close` (see [`docs/mcp/new-tools.md`](../mcp/new-tools.md))

## Safety invariants

The framework is **pure** by design. The caller can always rely on these properties:

- Detectors are pure functions: `(DetectorInput) => Evidence[]`. No `fs`, no `spawn`, no `fetch`, no `Math.random()`, no time-dependent logic.
- The emitter is a pure function: `(Evidence[], exitCode) => LoopClosureReport`.
- `closeLoop()` wraps the two in a single public call. It performs no I/O.
- Output is deterministic: identical inputs yield identical reports.
- Output is advisory: the returned `nextPrompt` is plain text. It is never auto-executed and contains no shell commands to evaluate.

This matters because the framework's whole job is to process *untrusted agent output*. Treating it as data, never as code, is how we keep it safe.

## Public API

```ts
import { closeLoop, type LoopClosureReport } from "@mandujs/skills/loop-closure";

const report: LoopClosureReport = closeLoop({
  stdout: child.stdout,
  stderr: child.stderr,
  exitCode: child.exitCode,
});

// {
//   stallReason: "3 test failures detected",
//   nextPrompt: "# Stall detected: 3 test failures detected (exit 1)\n...",
//   evidence: [
//     { kind: "test-failure", label: "math > divide", snippet: "math > divide" },
//     ...
//   ],
// }
```

Lower-level primitives are exported too:

- `runDetectors(input, only?)` — run all or a subset of detectors
- `emitReport(evidence, exitCode)` — compose a report from pre-computed evidence
- `emitNoStallReport(exitCode)` — the zero-evidence fallback
- `listDetectorIds()` — introspection
- `DEFAULT_DETECTORS` — the ordered registry

All detector functions are also exported individually (`detectTypecheckErrors`, `detectTestFailures`, etc.) for callers that want to wire in their own composition.

## Detectors

The default set covers ten stall categories, in priority-descending order:

| ID | Evidence kind | What it matches |
|---|---|---|
| `typecheck-error` | `typecheck-error` | `path/file.ts(line,col): error TSxxxx: ...` lines from `tsc` / Bun's diagnostics. |
| `test-failure` | `test-failure` | `(fail) <describe> > <case>` lines from `bun test`. |
| `missing-module` | `missing-module` | `Cannot find module 'x'`, `Could not resolve 'x'`, and bundler variants. |
| `syntax-error` | `syntax-error` | `SyntaxError: ...` banners from parsers. |
| `not-implemented` | `not-implemented` | `Error: not implemented`, `throw new Error("not implemented")`, `NotImplementedError`. |
| `unhandled-rejection` | `unhandled-rejection` | Node/Bun `Unhandled Promise Rejection` / `UnhandledPromiseRejectionWarning` / `unhandledRejection` banners. |
| `incomplete-function` | `incomplete-function` | Empty function bodies (`function f() {}`) and TODO-only arrow expressions (`(x) => { // TODO }`). |
| `todo-marker` | `todo-marker` | `TODO:` / `TODO(reviewer):` markers in output. |
| `fixme-marker` | `fixme-marker` | `FIXME:` / `FIXME(reviewer):` markers. |
| `stack-trace` | `stack-trace` | `at fn (/path:line:col)` frames — **gated on non-zero exit** and capped at 3 frames. |

Each detector returns zero or more `Evidence` rows:

```ts
interface Evidence {
  kind: EvidenceKind;
  file?: string;
  line?: number;
  snippet: string;
  label?: string;
}
```

Detectors err on the side of low false-positives — well-formed Mandu source text produces zero matches. The `unhandled-rejection` detector uses word boundaries so identifiers containing "UnhandledRejection" (like `detectUnhandledRejection`) don't match their own source code.

## Emitter

The emitter composes a multi-section `nextPrompt`:

```
# Stall detected: <reason> (exit <code>)

## Fix by:
<a conservative suggestion aligned with the primary evidence kind>

## Primary evidence (<label>):
- [<kind>] <file>:<line> — <snippet>
- ...

## Other signals:
- <other kind>: <count>
- ...

## Files touched:
- <sorted list of unique files, capped at 25>

## Next step:
Re-read the failing output, patch the listed files, then re-run the failing command to verify.
```

Priority selection: the dominant evidence kind wins `stallReason`. For example, if a run contains both typecheck errors AND test failures, the typecheck errors are reported as primary — fixing them is a prerequisite for the tests to even compile.

Determinism: primary evidence is sorted by `(file, line)` before rendering. File lists are alphabetically sorted. No timestamps, no random IDs, no environment reads.

## Edge cases

- **Zero evidence + exit 0** → `stallReason: "no-stall-detected"`, `nextPrompt` says to proceed.
- **Zero evidence + non-zero exit** → `stallReason: "no-patterns-matched"`, prompt invites manual inspection or a new detector.
- **Empty input** → treated as exit 0.
- **Oversized streams** → `closeLoop()` truncates each stream to the last 1,000,000 characters (tails are kept — error banners live at the end).
- **Malformed input** (non-string stdout, non-finite exit code) → defaults are applied silently; `closeLoop()` is total.

## Extending

To add a new detector:

1. Write a pure function conforming to `Detector` in [`packages/skills/src/loop-closure/detectors.ts`](../../packages/skills/src/loop-closure/detectors.ts).
2. Register it in `DEFAULT_DETECTORS` at the right priority position.
3. Add a test in [`__tests__/detectors.test.ts`](../../packages/skills/src/loop-closure/__tests__/detectors.test.ts) — one positive case, one negative (clean-output) case, and a determinism assertion.
4. Update the emitter's `LABELS` and `suggestFix()` helpers with a human-readable label and suggestion for the new `EvidenceKind`.

A new detector must pass the negative-control test: running it against a real Mandu source file from the repo must produce zero evidence.

## Related

- [`@mandujs/skills/loop-closure`](../../packages/skills/src/loop-closure/) — source
- [`mandu.loop.close` MCP tool](../mcp/new-tools.md#4-manduloopclose) — MCP surface
- [`@mandujs/skills` generator](../../packages/skills/src/generator/) — Phase 14.1 per-project skill generator that shares this framework's pure-function ethos

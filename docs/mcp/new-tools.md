---
phase: 14.3
track: Agent G
status: Shipped
audience: AI agents, MCP server operators, plugin authors
last_verified: 2026-04-19
bun_version: 1.3.12
depends_on:
  - packages/mcp/src/tools/
  - packages/skills/src/loop-closure/
---

# MCP — Phase 14.3 Loop-Closure Tool Suite

Four new tools were added to `@mandujs/mcp` as part of Phase 14.3 (Agent G). They close the loop between an agent's actions and the orchestrator that drives it: run the project's tests, preview a deploy without touching production, build a structured briefing for a fresh agent, and convert raw output into an actionable next-step prompt.

All four tools follow the existing `packages/mcp/src/tools/*` convention: an exported `*ToolDefinitions: Tool[]` array plus an exported `*Tools(projectRoot)` handler factory, registered via `TOOL_MODULES` in [`packages/mcp/src/tools/index.ts`](../../packages/mcp/src/tools/index.ts).

## 1. `mandu.run.tests`

Runs `mandu test` as a child process, parses the bun-test output, and returns a structured summary.

### Input schema

| Field | Type | Default | Description |
|---|---|---|---|
| `target` | `"unit" \| "integration" \| "e2e" \| "all"` | `"all"` | Subcommand passed through to `mandu test`. |
| `filter` | `string?` | — | Forwarded as `--filter <pattern>` to `bun test`. |
| `coverage` | `boolean?` | `false` | Adds `--coverage`. |

### Output shape

```ts
{
  target: "unit" | "integration" | "e2e" | "all",
  passed: number,
  failed: number,
  skipped: number,
  duration_ms?: number,
  failing_tests: Array<{ name: string; file?: string; error?: string }>,
  exit_code: number,
  note?: "no test files" | "timed out",
  stdout_tail?: string,   // last 2000 chars, for diagnostics
  stderr_tail?: string,
}
```

On validation failure the tool returns `{ error, field, hint }` with `isError: true` propagated by the MCP error handler. A child-process timeout is enforced at 10 minutes.

Empty test dirs produce `{ passed: 0, failed: 0, skipped: 0, note: "no test files" }` — callers get a benign zeroed summary instead of a crash.

## 2. `mandu.deploy.preview`

Invokes `mandu deploy --target=<target> --dry-run`. Always dry-run; the tool cannot trigger a real deployment.

### Input schema

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | one of `docker \| fly \| vercel \| railway \| netlify \| cf-pages \| docker-compose` | yes | Deployment adapter target. |

### Output shape

```ts
{
  target: DeployTarget,
  mode: "dry-run",
  artifact_list: Array<{ path: string; preserved: boolean; description?: string }>,
  warnings: string[],
  diff?: string,         // parsed from fenced diff blocks if present
  exit_code: number,
  stdout_tail?: string,
  stderr_tail?: string,
}
```

The artifact marker `+` (new) vs `•` (preserved) maps to `preserved: false | true`. Warning lines starting with `⚠️` or `Warning:` are collected separately.

## 3. `mandu.ai.brief`

Assembles a structured briefing for an AI agent newly attaching to the project.

### Input schema

| Field | Type | Default | Description |
|---|---|---|---|
| `depth` | `"short" \| "full"` | `"short"` | `short` trims lists for fast ingestion; `full` returns the complete view. |

### Output shape

```ts
{
  title: string,                 // "<pkg.name> @ <version>"
  summary: string,               // pkg.description or default
  depth: "short" | "full",
  files: string[],               // package.json, mandu.config.*, AGENTS.md, CLAUDE.md, manifest
  skills: Array<{ id; source: "static" | "generated"; path? }>,
  recent_changes: Array<{ hash; subject; author?; date? }>,   // last 20 commits
  docs: Array<{ path; title }>,  // top-level docs/*.md files
  config: {
    guard_preset?: string,
    fs_routes?: boolean,
    has_playwright?: boolean,
  },
  suggested_next: string[],      // derived heuristics
}
```

The tool is read-only. It invokes `git log` as a 10-second-capped child process; failures produce empty `recent_changes` rather than erroring.

## 4. `mandu.loop.close`

Adapts the pure [`closeLoop()`](../prompts/loop-closure.md) function from `@mandujs/skills/loop-closure` into an MCP tool surface. Given `stdout`, `stderr`, and `exitCode` from the most recent child-process run, it identifies the dominant stall pattern and composes an advisory `nextPrompt`.

### Input schema

| Field | Type | Default | Description |
|---|---|---|---|
| `stdout` | `string?` | `""` | Captured stdout. |
| `stderr` | `string?` | `""` | Captured stderr. |
| `exitCode` | `number?` | `0` | Child-process exit code. |
| `detectors` | `string[]?` | all | Optional allow-list of detector IDs. |

### Output shape

```ts
{
  stallReason: string,
  nextPrompt: string,
  evidence: Array<{ kind; file?; line?; snippet; label? }>,
  detectors_run: string[],
}
```

### Safety

`mandu.loop.close` is **pure**: the underlying function never writes files, never spawns processes, and never performs I/O. It is declared `readOnlyHint: true`. The returned `nextPrompt` is advisory text — an orchestrator decides whether to feed it back into the agent.

See [Loop Closure — Prompts](../prompts/loop-closure.md) for the full list of detectors and sample prompts.

## Discovery & registration

All four tools are registered through the standard `TOOL_MODULES` array in `packages/mcp/src/tools/index.ts`. They appear in the `mandu-mcp` server's `list_tools` response without any profile enabled (i.e. in the default `full` profile). To expose them in the `minimal` or `standard` profiles, add the category IDs (`run-tests`, `deploy-preview`, `ai-brief`, `loop-close`) to [`profiles.ts`](../../packages/mcp/src/profiles.ts).

## Testing

Test files mirror the tools under `packages/mcp/tests/tools/`:

- `run-tests.test.ts` — 14 tests (definition shape, input validation, parser correctness)
- `deploy-preview.test.ts` — 14 tests (definition shape, input validation, artifact/warning/diff parsing)
- `ai-brief.test.ts` — 14 tests (definition shape, fake-project handler, `buildSuggestedNext` heuristics)
- `loop-close.test.ts` — 13 tests (definition shape, validation, determinism, detector allow-list)

Run with `cd packages/mcp && bun test`.

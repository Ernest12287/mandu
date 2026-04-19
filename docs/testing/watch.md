---
title: "Testing — Watch mode"
status: phase-12.3
audience: Mandu app authors
bun_version: "1.3.12"
related:
  - packages/cli/src/commands/test.ts
  - docs/testing/getting-started.md
---

# Watch mode — `mandu test --watch`

`--watch` keeps a persistent chokidar watcher over `app/`, `src/`, and
`packages/` and re-runs only the tests affected by each change. This
makes the red-green-refactor cycle a ~500ms round-trip even on large
projects.

---

## Quick start

```bash
# Watch everything, re-run affected tests on change
mandu test --watch

# Preview what would be watched (and exit 0 without starting)
mandu test --watch --dry-run

# Watch + coverage — re-runs emit fresh LCOV into .mandu/coverage
mandu test --watch --coverage
```

Stop with `Ctrl+C`.

---

## How it works

1. **Chokidar watcher** — recursively watches the Mandu layout dirs
   (`app/`, `src/`, `packages/`), ignoring `node_modules/`, `.git/`,
   `.mandu/`, `dist/`.
2. **200ms debounce** — batches bursts of changes (IDE save on
   multiple files) into a single re-run.
3. **Affected-file mapping** — for each change, pick tests that:
   - **Directly match** — the changed file IS a `*.test.ts` /
     `*.test.tsx`.
   - **Import** the changed file — tests that reference the basename
     (or extension-stripped stem) in their source.
4. **Re-run** — invoke `bun test` with the narrowed file list. The
   full config (timeouts, snapshots, coverage) is preserved.

Concurrency is guarded: if a re-run is already in flight when new
changes arrive, we coalesce them into a single follow-up batch
instead of piling up subprocesses.

---

## Flag compatibility

| Flag             | Behavior under `--watch`                         |
| ---------------- | ------------------------------------------------ |
| `--filter`       | Forwarded to every re-run invocation.            |
| `--coverage`     | Coverage is emitted per re-run. Merged LCOV is  |
|                  | NOT automatic — run `--coverage` without         |
|                  | `--watch` for a final merged report.             |
| `--bail`         | Stops the current re-run on first failure.       |
| `--update-snapshots` | Forwarded — useful when reviewing a new UI.   |
| `--e2e`          | Incompatible — use `mandu test:watch` for E2E    |
|                  | watch (ATE pipeline).                            |
| `--dry-run`      | Prints the plan and exits 0.                     |

---

## Dry-run example

```bash
$ mandu test --watch --dry-run
mandu test --watch plan
  debounce:    200ms
  targets:     unit, integration
  test files:  126
  watch dirs:  3
    - /repo/app
    - /repo/src
    - /repo/packages
```

---

## Affected-file heuristic

We intentionally use a cheap grep-equivalent rather than the full ATE
dep-graph (`ts-morph` based, ~500ms build). For a sub-second watch
loop, substring import scanning hits the sweet spot between:

- **Speed**: O(changed_files × test_files) string-contains — under
  100ms even at 500+ changes.
- **Precision**: matches both `.ts`-suffixed and extension-stripped
  imports.
- **Recall**: may over-include tests with coincidental basename
  matches — acceptable because false positives only cost a test run,
  not correctness.

For **exact transitive impact**, use `mandu test:watch` which wraps
the full ATE `computeImpact()` → `dep-graph` pipeline at the cost of
~500ms startup.

---

## Regression tests to be aware of

- **No watch dirs** — if `app/`, `src/`, and `packages/` are all
  missing, the watcher refuses to start and emits `CLI_E066`.
- **Concurrent changes** — 500 saves in 200ms produce a single
  re-run. See `computeAffectedTests` tests.
- **Unreadable test files** — a temporarily inaccessible test file is
  dropped from the affected list without crashing the loop.

---

## Exit codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
|   0  | `--dry-run` planning OR graceful Ctrl+C     |
|   2  | Watcher infra error (fs.watch EACCES etc.)  |
|   4  | No watch dirs (CLI_E066)                    |

---

## Troubleshooting

**No reaction to my save** — check the file path is inside one of the
watched dirs (`app/`, `src/`, `packages/`). Changes to `docs/` or
`scripts/` are intentionally ignored.

**Too many re-runs** — increase the debounce window by editing
`packages/cli/src/commands/test.ts::DEBOUNCE` (currently 200ms). A
future release will expose this as a flag.

**Tests I expected to run didn't re-run** — the basename heuristic
matches on substring. If your source file name is very common (e.g.
`types.ts`), consider renaming it to something more distinctive, or
use `mandu test:watch` which uses the full dep-graph.

---
title: "Testing — Coverage (LCOV merge)"
status: phase-12.3
audience: Mandu app authors
bun_version: "1.3.12"
related:
  - packages/cli/src/commands/test.ts
  - packages/ate/src/coverage-merger.ts
  - docs/testing/getting-started.md
  - docs/testing/e2e.md
---

# Coverage with `mandu test --coverage`

`--coverage` turns on Bun's native line coverage and, when combined
with `--e2e`, also enables Playwright V8 coverage. Both outputs land in
separate LCOV files which Mandu merges into a single canonical file at
`.mandu/coverage/lcov.info` — the conventional location for Codecov,
Coveralls, genhtml, and nyc-report.

---

## Quick start

```bash
# Unit + integration coverage only
mandu test --coverage

# Full coverage including E2E (Playwright V8)
mandu test --coverage --e2e

# CI: fail when below threshold (see mandu.config below)
mandu test --coverage --bail
```

---

## Output path

```
.mandu/
└── coverage/
    └── lcov.info     # merged canonical output (LCOV v2)
```

Upstream sources that get merged in:

- `coverage/lcov.info` — Bun's default coverage output (per `bunfig.toml`).
- `.mandu/coverage/unit.lcov` — optional Bun fallback location.
- `coverage/e2e.lcov` — Playwright V8 coverage (via `PW_COVERAGE=1`).

Missing inputs are silently skipped. Running `--coverage` unit-only
still produces `.mandu/coverage/lcov.info` — just without the E2E
records.

---

## Threshold enforcement

Configure minimum coverage in `mandu.config.ts`:

```ts
// mandu.config.ts
export default {
  test: {
    coverage: {
      lines: 80,     // fail CI if < 80% lines hit
      branches: 60,  // reserved — not yet enforced
    },
  },
};
```

When set, `mandu test --coverage` exits **1** and prints `CLI_E065`
with `actual% < expected%` if the threshold is not met.

Thresholds are evaluated on the **merged** LCOV, so unit + E2E hits
are combined before the check.

---

## Merging behavior

The merger (`@mandujs/ate/coverage-merger`) is a pure LCOV v2
parser/serializer:

- `DA:` line hits are **summed** across inputs.
- `FNDA:` function hits are **summed** by function name.
- `BRDA:` branch hits are **summed** by (line, block, branch).
- Records are emitted in **sorted source-file order** for byte-stable
  CI diffs.
- `LF/LH/BRF/BRH/FNF/FNH` summaries are **recomputed** after merge.

Round-trip invariant: `parse(serialize(parse(x))) === parse(x)`.

---

## Programmatic API

```ts
import {
  mergeAndWriteLcov,
  mergeLcovFiles,
  parseLcov,
} from "@mandujs/ate";

// Merge + write in one call.
const res = mergeAndWriteLcov({
  repoRoot: process.cwd(),
  inputs: [
    { label: "unit", source: { kind: "file", path: "coverage/lcov.info" } },
    { label: "e2e", source: { kind: "file", path: "coverage/e2e.lcov" } },
  ],
});
console.log(`merged ${res.summary.files} files → ${res.outputPath}`);

// Or merge in-memory for custom reporters.
const parsed = mergeLcovFiles([...]);
console.log(parsed.lcov);          // canonical body
console.log(parsed.summary);       // { linesFound, linesHit, ... }
```

---

## CI integration

**GitHub Actions + Codecov**:

```yaml
- run: mandu test --coverage --e2e
- uses: codecov/codecov-action@v4
  with:
    files: .mandu/coverage/lcov.info
```

**genhtml (HTML report)**:

```bash
mandu test --coverage --e2e
genhtml .mandu/coverage/lcov.info --output-directory .mandu/coverage/html
```

---

## Exit codes

| Code | Meaning                                        |
| ---- | ---------------------------------------------- |
|   0  | All tests passed + coverage ≥ threshold        |
|   1  | Any test failed OR coverage below threshold    |
|   4  | Coverage config invalid (schema error)         |

---

## Troubleshooting

**`.mandu/coverage/lcov.info` is missing** — check that `--coverage` was
passed. When no LCOV sources exist on disk, the merge step is skipped
(no empty file is written).

**Threshold fails unexpectedly** — inspect the merged LCOV directly to
see per-file LF/LH. A single file with very low coverage can drag the
aggregate below the line threshold even when "most" files are fine.

**Playwright coverage is empty** — ensure your test files honor
`PW_COVERAGE=1`. Mandu's generated specs from `ateGenerate` include the
V8 collection block by default.

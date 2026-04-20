---
title: Accessibility
status: stable
phase: 18.χ
tags: [a11y, architect, build, diagnose, axe-core]
---

# Accessibility in Mandu

Mandu ships a framework-level accessibility guardrail: `mandu build --audit` runs [axe-core](https://github.com/dequelabs/axe-core) against every prerendered HTML page and reports WCAG violations. `mandu diagnose` includes an `a11y_hints` smoke check that runs a single-page audit in under a second.

Both paths are **opt-in** and carry zero runtime cost until you install the optional dependencies.

## Design goals

- **Zero-dep by default.** axe-core is ~1 MB of rules. It is declared as an optional `peerDependency` of `@mandujs/core`; it is never bundled into your application. Installing it is a deliberate, one-line choice.
- **Graceful degradation.** When axe-core is absent the runner prints a single informational line ("axe-core not installed — skipping audit") and exits 0. Audits never block a build unless you explicitly ask them to via `--audit-fail-on`.
- **DOM provider fallback.** The runner prefers [jsdom](https://github.com/jsdom/jsdom) (axe's reference DOM) but falls back to [happy-dom](https://github.com/capricorn86/happy-dom) if only HappyDOM is present. Many Mandu test setups already pull in HappyDOM, so the 80% path "just works" with one install.
- **Actionable output.** For common rule ids (`color-contrast`, `image-alt`, `label`, `heading-order`, …) the report attaches a one-line fix recipe. Unknown rules link to axe's official documentation.

## Enabling the audit

Install the optional peers:

```sh
bun add -d axe-core jsdom
# or: bun add -d axe-core happy-dom
```

Run the audit at the end of your build:

```sh
mandu build --audit
```

Sample output:

```
♿ Accessibility audit (Phase 18.χ)
==================================================
Accessibility audit (axe-core)
==================================================
  Files scanned: 12  ·  Violations: 3  ·  Duration: 420ms
  By impact: minor=0  moderate=1  serious=1  critical=1
  Min impact: minor

  [CRITICAL] color-contrast  —  Elements must have sufficient color contrast
     Fix: Increase foreground/background contrast to meet WCAG AA 4.5:1 for normal text (3:1 for large).
     1 file(s), 1 node(s)
     Docs: https://dequeuniversity.com/rules/axe/4.x/color-contrast

  [SERIOUS] image-alt  —  Images must have alternate text
     Fix: Add an `alt` attribute to every <img>. Decorative images should use `alt="".
     1 file(s), 2 node(s)
     Docs: https://dequeuniversity.com/rules/axe/4.x/image-alt

  [MODERATE] landmark-one-main  —  Document should have one main landmark
     1 file(s), 1 node(s)
```

### Flags

| Flag | Effect |
|------|--------|
| `--audit` | Run axe-core against every `.mandu/prerendered/**/*.html`. Informational by default — does not fail the build. |
| `--audit-fail-on=<impact>` | Fail the build with a non-zero exit code when any violation at `<impact>` or higher is found. Accepts `minor \| moderate \| serious \| critical`. |

## CI integration

Block PRs on critical violations:

```yaml
# .github/workflows/ci.yml
- run: bun install
- run: bun run build -- --audit --audit-fail-on=critical
```

Tighter policy (any serious+ violation fails the PR):

```sh
mandu build --audit --audit-fail-on=serious
```

Purely informational (never fails, useful for trend tracking):

```sh
mandu build --audit
# inspect the printed report; post it to PR comments via your CI runner
```

## `mandu diagnose` integration

`mandu diagnose` runs a cheap a11y smoke against the first prerendered HTML file it finds. Severity is at most `warning` — full-build auditing is what `mandu build --audit` is for; the diagnose smoke is a 250 ms signal that something needs attention.

Behaviour matrix:

| Project state | Diagnose outcome |
|---|---|
| No prerendered HTML yet | ok ("Nothing to audit") |
| axe-core / DOM provider missing | ok (informational, audit skipped) |
| Audit runs, 0 critical violations | ok |
| Audit runs, critical violations found | warning |

## Programmatic API

The runner is exported as `@mandujs/core/a11y`:

```ts
import { runAudit, formatAuditReport } from "@mandujs/core/a11y";

const report = await runAudit(
  ["dist/index.html", "dist/about/index.html"],
  { minImpact: "serious" }
);

if (report.outcome === "axe-missing") {
  console.log(report.note);
} else {
  console.log(formatAuditReport(report));
}
```

Full types: `AuditReport`, `AuditViolation`, `AuditNode`, `AuditImpact`, `RunAuditOptions`.

## Fix recipes

A non-exhaustive index of the rules the runner recognises and the accompanying one-line fix. Full list in `@mandujs/core/a11y` `AXE_RULE_FIX_HINTS`.

- **color-contrast** — Increase foreground/background contrast to meet WCAG AA 4.5:1 for normal text (3:1 for large).
- **image-alt** — Add an `alt` attribute to every `<img>`. Decorative images should use `alt=""`.
- **label** — Associate every form control with a `<label for="id">` or wrap it in `<label>`.
- **link-name** / **button-name** — Ensure interactive elements expose accessible text (visible, `aria-label`, or `aria-labelledby`).
- **heading-order** — Headings must increase by one level at a time — don't skip from `<h2>` to `<h4>`.
- **html-has-lang** — Set `lang` on `<html>`. Configure via `metadata.lang` or the root layout.
- **document-title** — Render a non-empty `<title>`. Mandu's `metadata.title` exports auto-populate this.
- **duplicate-id** — Every `id` must be unique. Check island + SSR output for collisions.
- **landmark-one-main** / **region** — Wrap primary content in `<main>`, and place all content inside a landmark.

## Performance envelope

- jsdom parse + axe rules per page: typically 30–120 ms on prerendered Mandu output.
- Runner caps input at 500 files by default (`maxFiles` option). A misconfigured build that emitted 10k routes will not hang CI.
- Violations are grouped by rule id in the printed table to keep the output navigable even when a systemic issue (e.g. a missing landmark in the root layout) fires on every page.

## Non-goals

- **Not a replacement for manual a11y review.** axe-core catches ~40% of WCAG failures. Keyboard navigation, screen-reader flow, and cognitive accessibility still require human testing.
- **Not a bundle-size budget.** Budget enforcement lives in Phase 18.φ — see `docs/architect/bundle-budget.md`.
- **Not a performance audit.** Lighthouse-style performance/SEO audits are out of scope.

## Related

- `packages/core/src/a11y/` — runner implementation, types, fix-hint catalog.
- `packages/core/src/diagnose/checks.ts::checkA11yHints` — diagnose integration (Phase 18.ν).
- `packages/cli/src/commands/build.ts` — CLI wiring for `--audit` / `--audit-fail-on`.
- [axe-core rule reference](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)

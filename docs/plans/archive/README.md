# Archived plans / RFCs

These documents were proposed via pull requests but **closed without
merging**. Bodies are preserved verbatim here so the ideas don't get
lost — you can pick one up and re-propose it as an active plan when
the timing fits.

Archived on **2026-05-06**.

| File | Origin PR | Topic |
|---|---|---|
| [`13_seo_production_readiness_plan.md`](./13_seo_production_readiness_plan.md) | [#153](https://github.com/konamgil/mandu/pull/153) | SEO production-readiness — Phase 0–6, top-20 backlog, KPI/risks |
| [`14_db_production_readiness_plan.md`](./14_db_production_readiness_plan.md) | [#154](https://github.com/konamgil/mandu/pull/154) | DB production-readiness — Phase 0–7, overlaps `docs/bun/phases-4-plus.md` Phase 4 |
| [`18_kitchen_ai_copilot_rfc.md`](./18_kitchen_ai_copilot_rfc.md) | [#158](https://github.com/konamgil/mandu/pull/158) | Kitchen DevTool AI Copilot — Vercel AI SDK, Builder/Guide/Maintainer modes |
| [`20_kitchen_design_copilot_rfc.md`](./20_kitchen_design_copilot_rfc.md) | [#160](https://github.com/konamgil/mandu/pull/160) | Kitchen Design Copilot + dev-only `/__mandu/design-system` page |
| [`21_i18n_production_plan.md`](./21_i18n_production_plan.md) | [#161](https://github.com/konamgil/mandu/pull/161) | i18n production-readiness — route-first, hreflang/sitemap, `check --i18n` |
| [`22_lintless_realtime_code_guard_rfc.md`](./22_lintless_realtime_code_guard_rfc.md) | [#162](https://github.com/konamgil/mandu/pull/162) | Lintless real-time code guard — Activity Stream + built-in Rule Evaluator |

## Why these specifically

These six touch the **framework core** (guard, i18n, DB, SEO, kitchen
devtools, design system) and the ideas may resurface when those areas
are picked up. Other closed PRs from the same batch — `@mandujs/fast`,
`@mandujs/query`, mobile-native shell, state-mgmt recommendations,
TypeScript skill pack — were ecosystem proposals and intentionally not
preserved here (they're still readable on GitHub if needed).

## Status

These are **not active plans**. Treat them as historical proposals.
If you want to revive one:

1. Move the file out of `archive/` into `docs/plans/`.
2. Renumber if it collides with a current plan number.
3. Open a fresh PR — don't try to revive the original PR thread.

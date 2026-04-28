---
"@mandujs/core": minor
---

feat(#245 M2): Guard `DESIGN_INLINE_CLASS` rule (build gate)

Issue #245 M2 — the actual build gate. The Guard pipeline now refuses to ship a build when a `className` literal contains a forbidden token outside the canonical component dirs. This is the regression-blocking part of #245: agents that re-inline `btn-hard` across pages now hit a hard fail with a message that names the replacement component.

**Config (`mandu.config.ts`)**:

```ts
guard: {
  design: {
    designMd: "DESIGN.md",                          // default
    forbidInlineClasses: ["btn-hard", "shadow-hard"], // explicit list
    autoFromDesignMd: true,                          // also pull from DESIGN.md §7 Don't
    requireComponent: {
      "btn-hard": "@/client/shared/ui#MButton",
    },
    exclude: ["src/client/shared/ui/**", "src/client/widgets/**"], // default
    severity: "error",                               // default
  },
}
```

**Behaviour**:

- Scans `<rootDir>/src` and `<rootDir>/app` for `.ts`/`.tsx`/`.js`/`.jsx`.
- Detects forbidden tokens inside any string literal (`"…"`, `'…'`, `` `…` ``). Strips Tailwind variant prefixes (`hover:btn-hard` matches `btn-hard`).
- `autoFromDesignMd: true` extracts forbid tokens from DESIGN.md §7 Do's & Don'ts — every backticked token in a "Don't" rule (`Inline \`btn-hard\` directly`) becomes a forbid entry.
- Default `exclude` skips `src/client/shared/ui/**` and `src/client/widgets/**` so the canonical component dirs (where the forbidden classes legitimately live) don't self-flag.
- Violations carry the replacement component in both `message` and `suggestion` so an agent reading the diagnostic can fix the regression directly.

**Implementation note**: detection is regex-based, not AST-based. The Guard pass runs frequently and a string-literal sweep is O(n) over file size with no parse failures. Tradeoff: forbidden tokens inside comments still flag — the regression we exist to prevent matters more than that false positive.

Tests in `packages/core/src/guard/__tests__/design-inline-class.test.ts`.

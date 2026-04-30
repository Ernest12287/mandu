---
"@mandujs/core": patch
---

fix(#253): SPA router no longer drops the first click after #252

Regression on top of #252. When `document.startViewTransition()`
aborts before its callback runs (rapid navigation, popstate races,
the user clicks a second link before the first transition finishes),
the browser SKIPS the callback — meaning the in-flight `applyUpdate`
never executes and the click is silently lost. #252 quieted the
console-side rejection but the navigation it was driving disappeared
along with it. Symptom: "first click does nothing, second click works."

Both `client/router.ts` and the inlined `spa-nav-helper.ts` script
now wrap the callback with an `applied` flag and run it directly
when any of `updateCallbackDone` / `ready` / `finished` reject before
the callback fires. The flag prevents double-apply when the
transition completes normally.

Regression test added in `packages/core/tests/client/router.test.ts`
that mocks the spec abort path and asserts the URL + router state
update anyway.

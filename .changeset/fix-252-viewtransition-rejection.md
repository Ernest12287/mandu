---
"@mandujs/core": patch
---

fix(#252): swallow ViewTransition promise rejections in SPA router

`document.startViewTransition()` returns an object whose `.finished`,
`.ready`, and `.updateCallbackDone` promises reject with
`InvalidStateError: Transition was aborted because of invalid state`
when a newer navigation aborts the in-flight transition. The router
called `startViewTransition` but never attached `.catch()` handlers,
so those rejections escaped to the global error handler — visible as
an unhandled promise rejection on every rapid SPA navigation.

Both call sites now attach noop catches:

- `packages/core/src/client/router.ts` — typed router `navigate()`
- `packages/core/src/client/spa-nav-helper.ts` — inlined SSR helper

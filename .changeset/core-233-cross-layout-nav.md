---
"@mandujs/core": patch
---

fix(core/spa-nav): #233 cross-layout transitions fall back to hardNav

SPA navigation's `<main>.innerHTML` swap left the source layout chrome
(e.g. docs `<aside>` sidebar) intact when moving between pages that
use different layout trees — home ↔ docs, home ↔ dashboard, etc. —
producing a visually broken page until the user pressed F5.

Fix — the SSR shell now stamps `data-mandu-layout="<hash>"` on
`<div id="root">`, derived from the active `layoutChain`. The SPA
helper compares the current DOM's key against the parsed destination
key inside `doSwap`; mismatched keys abort the soft swap and run a
real `location.href = url` hard navigation.

Same-layout transitions (e.g. `/blog/a` → `/blog/b`) keep the cheap
swap. Pages without a layout chain omit the attribute entirely, which
the helper treats as a wildcard match (no regression).

Stamped on both the non-streaming path (`ssr.ts::renderToHTML`) and
the streaming shell (`streaming-ssr.ts::generateHTMLShell`) so the
heuristic works regardless of render mode.

3 new regression guard tests in `spa-nav-body-swap.test.ts` ensure
the `data-mandu-layout` attribute, the "cross-layout transition"
fallback reason string, and the key-compare block all stay in the
minified helper body.

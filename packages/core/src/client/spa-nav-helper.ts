/**
 * Issue #208 — Minimal inline SPA-navigation helper.
 *
 * Self-contained IIFE injected into the SSR `<head>` that upgrades plain
 * full-page navigations into client-side `history.pushState` +
 * `fetch` + DOM-swap transitions, without loading any JS bundle.
 *
 * Motivating use case: docs / blog / marketing sites that build with
 * `hydration: "none"` (no islands). Under Issue #193 the opt-out SPA
 * router lives in `@mandujs/core/client` (`router.ts`), which only ships
 * inside a hydration bundle. Zero-JS pages therefore lost the "feels
 * like a SPA" behavior that `spa: true` (the framework default) promises.
 *
 * This helper fills the gap: ~1.6 KB of inline JavaScript that the
 * browser parses and runs immediately, no module graph, no network
 * round-trip. Paired with the `@view-transition { navigation: auto }`
 * style block (#192) the result is a visually-animated pushState
 * navigation on every internal link click.
 *
 * Design constraints (locked — changing any of these needs an explicit
 * rationale in the PR):
 *
 *   1. **Exclusion parity with the full router** (`router.ts`
 *      `handleLinkClick`): every browser-owned escape hatch — modifier
 *      keys, non-left click, `target` other than `_self`, `download`,
 *      `mailto:` / `tel:` / `javascript:` / …, cross-origin, hash-only,
 *      no `href`, `data-no-spa`, and `event.defaultPrevented` — is
 *      checked here too. Regression matrix lives at
 *      `tests/client/spa-nav-helper-exclusions.test.ts`.
 *
 *   2. **Co-existence with the full router**: both handlers listen
 *      on `document` `click`. The helper bails out early when
 *      `window.__MANDU_ROUTER_STATE__` is present — that global is
 *      installed by `initializeRouter()` before it calls
 *      `addEventListener`, so on hydrated pages the full router wins.
 *      On pure-SSR pages the state global is missing and the helper
 *      is authoritative.
 *
 *   3. **View Transitions API** — we call
 *      `document.startViewTransition(cb)` when available, mirroring the
 *      `@view-transition` at-rule we already inject. Browsers without
 *      the API (Firefox, Safari < 18.2) execute the callback
 *      synchronously so the feature is a pure progressive enhancement.
 *
 *   4. **DOM swap strategy**: replace `document.body.innerHTML` using
 *      the parsed incoming document's `<body>`. This preserves the
 *      `<head>` across navigations (avoids re-running inline scripts
 *      like this helper) while still picking up `<title>` and
 *      `<meta>` changes via a selective head-element merge. We also
 *      reset `document.title`.
 *
 *   5. **Inline, not external**: same rationale as #192's prefetch
 *      helper — inline removes the extra round-trip on every SSR
 *      response, keeps the CSP posture simple (only two inline scripts:
 *      prefetch + spa-nav), and sidesteps the "zero-JS but loads one
 *      JS file anyway" awkwardness.
 *
 *   6. **Opt-out via `ssr.spa: false`**: the injection site
 *      (`ssr.ts::renderToHTML`, `streaming-ssr.ts::generateHTMLShell`)
 *      omits the `<script>` block entirely when the user's config sets
 *      `spa: false`. No runtime check needed inside the IIFE.
 *
 * The exported `SPA_NAV_HELPER_SCRIPT` wraps the IIFE in a
 * `<script>` tag, ready to paste into `<head>` alongside the prefetch
 * helper and `@view-transition` style block.
 *
 * Size target: ≤3 KB raw (currently ≈2.7 KB after the defensive
 * hardNav / DOMParser-availability guards). If this grows past 3 KB we
 * should revisit the inline-vs-external trade-off.
 */

/**
 * Inner IIFE — exposed for unit tests that want to parse the source.
 *
 * Byte-minified on purpose (no comments, short names). The high-level
 * flow is documented in this file's JSDoc; anyone editing this string
 * MUST update the exclusion-matrix test to match.
 */
export const SPA_NAV_HELPER_BODY = `(function(){if(typeof document==="undefined"||typeof window==="undefined")return;var L=window.location;var H=window.history;function hardNav(u){try{L.href=u;}catch(_){}}function okAnchor(a){if(!a||!a.getAttribute)return null;if(a.hasAttribute("data-no-spa"))return null;if(a.hasAttribute("download"))return null;var t=a.getAttribute("target");if(t&&t!=="_self")return null;var h=a.getAttribute("href");if(!h||h.charAt(0)==="#")return null;var u;try{u=new URL(h,L.origin);}catch(_){return null;}if(u.origin!==L.origin)return null;if(u.protocol!=="http:"&&u.protocol!=="https:")return null;return u;}function swap(doc){try{var newTitle=doc.querySelector("title");if(newTitle)document.title=newTitle.textContent||document.title;var nh=doc.head,ch=document.head;if(nh&&ch){var keep={};var metas=ch.querySelectorAll("meta[name=viewport],meta[charset]");for(var i=0;i<metas.length;i++)keep[metas[i].outerHTML]=true;var sel="meta,link[rel=icon],link[rel=shortcut icon],link[rel=canonical]";var oldMetas=ch.querySelectorAll(sel);for(var j=0;j<oldMetas.length;j++){if(!keep[oldMetas[j].outerHTML])oldMetas[j].parentNode.removeChild(oldMetas[j]);}var newMetas=nh.querySelectorAll(sel);for(var k=0;k<newMetas.length;k++){if(!keep[newMetas[k].outerHTML])ch.appendChild(newMetas[k].cloneNode(true));}}var nb=doc.body;if(nb)document.body.innerHTML=nb.innerHTML;try{window.scrollTo(0,0);}catch(_){}}catch(_){}}function nav(url,push){fetch(url,{credentials:"same-origin",headers:{"Accept":"text/html"}}).then(function(r){if(!r.ok||!r.headers.get("content-type")||r.headers.get("content-type").indexOf("text/html")<0){hardNav(url);return null;}return r.text();}).then(function(html){if(html==null)return;if(typeof DOMParser==="undefined"){hardNav(url);return;}var doc;try{doc=new DOMParser().parseFromString(html,"text/html");}catch(_){hardNav(url);return;}if(push){try{H.pushState({mandu:1},"",url);}catch(_){hardNav(url);return;}}var run=function(){swap(doc);try{window.dispatchEvent(new CustomEvent("mandu:spa-navigate",{detail:{url:url}}));}catch(_){}};if(typeof document.startViewTransition==="function"){try{document.startViewTransition(run);}catch(_){run();}}else{run();}}).catch(function(){hardNav(url);});}document.addEventListener("click",function(e){if(e.defaultPrevented)return;if(e.button!==0||e.metaKey||e.altKey||e.ctrlKey||e.shiftKey)return;if(window.__MANDU_ROUTER_STATE__)return;var tgt=e.target;var a=tgt&&typeof tgt.closest==="function"?tgt.closest("a"):null;if(!a)return;var url=okAnchor(a);if(!url)return;e.preventDefault();nav(url.pathname+url.search+url.hash,true);},false);window.addEventListener("popstate",function(){if(window.__MANDU_ROUTER_STATE__)return;nav(L.pathname+L.search+L.hash,false);});window.__MANDU_SPA_HELPER__=1;})();`;

/** Ready-to-inject `<script>` tag for SSR `<head>` injection. */
export const SPA_NAV_HELPER_SCRIPT = `<script>${SPA_NAV_HELPER_BODY}</script>`;

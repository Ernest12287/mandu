/**
 * Curated fix hints for the most common axe-core rules we see in the
 * wild during framework dogfooding. Each hint is a single actionable
 * sentence — long enough to be useful, short enough to fit in a CI
 * table cell. When a rule is not in this map the runner simply omits
 * `fixHint` and callers fall back to axe's `helpUrl` link.
 *
 * Rule ids mirror axe-core's canonical list:
 *   https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md
 */
export const AXE_RULE_FIX_HINTS: Record<string, string> = {
  "color-contrast":
    "Increase foreground/background contrast to meet WCAG AA 4.5:1 for normal text (3:1 for large).",
  "image-alt":
    "Add an `alt` attribute to every <img>. Decorative images should use `alt=\"\"`.",
  "label":
    "Associate every form control with a <label for=\"id\"> or wrap it in <label>.",
  "link-name":
    "Ensure <a> elements contain accessible text (visible, aria-label, or aria-labelledby).",
  "button-name":
    "Give every <button> an accessible name: visible text, aria-label, or aria-labelledby.",
  "document-title":
    "Render a non-empty <title> inside <head>. Mandu's `metadata.title` exports auto-populate this.",
  "html-has-lang":
    "Set `lang` on <html>. In Mandu, configure via `metadata.lang` or the root layout.",
  "html-lang-valid":
    "Use a BCP-47 language code (`en`, `ko`, `en-US`) — case-sensitive region subtag matters.",
  "landmark-one-main":
    "Wrap primary content in exactly one <main> landmark per page.",
  "region":
    "Place all content inside a landmark (<header>, <main>, <nav>, <footer>, or role=\"region\").",
  "duplicate-id":
    "Every `id` must be unique in the DOM. Check island + SSR output for collisions.",
  "duplicate-id-active":
    "Focusable elements must have unique ids — screen readers cannot resolve duplicates.",
  "duplicate-id-aria":
    "ids referenced by aria-* attributes must be unique (one target per reference).",
  "meta-viewport":
    "Do not disable user scaling: avoid `user-scalable=no` or `maximum-scale<2` in <meta name=viewport>.",
  "aria-valid-attr":
    "Remove unknown aria-* attributes. Check for typos (`aria-labeledby` → `aria-labelledby`).",
  "aria-valid-attr-value":
    "aria-* attribute values must match the allowed set for that attribute.",
  "aria-required-attr":
    "The ARIA role you used requires additional attributes (e.g. role=\"slider\" needs aria-valuenow).",
  "aria-roles":
    "Use a valid ARIA role. Custom roles (`role=\"card\"`) are ignored by screen readers.",
  "list":
    "<ul>/<ol> must contain only <li> children (plus script/template). Wrap other content inside <li>.",
  "listitem":
    "<li> must have a parent <ul>, <ol>, or <menu>.",
  "heading-order":
    "Headings must increase by one level at a time — don't skip from <h2> to <h4>.",
  "empty-heading":
    "Remove empty heading tags or add text content — they confuse screen-reader navigation.",
  "tabindex":
    "Avoid tabindex values greater than 0 — they break the natural focus order.",
  "frame-title":
    "Give every <iframe> a `title` attribute describing its contents.",
  "object-alt":
    "Provide fallback text for <object> via its text content or `aria-label`.",
  "video-caption":
    "Every <video> must have at least one <track kind=\"captions\">.",
  "bypass":
    "Include a skip-link or a landmark so keyboard users can bypass repeated blocks.",
} as const;

/**
 * Return the fix hint for a rule id, or `undefined` when we don't have
 * one. Kept as a function (rather than direct map access) so the
 * lookup layer can evolve (e.g. add localization) without rippling
 * through call sites.
 */
export function getFixHint(ruleId: string): string | undefined {
  return AXE_RULE_FIX_HINTS[ruleId];
}

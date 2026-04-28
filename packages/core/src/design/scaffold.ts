/**
 * Scaffold + upstream import primitives.
 *
 * `EMPTY_DESIGN_MD` is the canonical 9-section skeleton Mandu ships
 * for `mandu design init` (no `--from`). It contains heading slots and
 * a one-line hint per section so users / agents can fill it in.
 *
 * `fetchUpstreamDesignMd(slug)` pulls a brand DESIGN.md from VoltAgent's
 * awesome-design-md repository (raw GitHub). The function is a thin
 * fetch wrapper — caller decides what to do with the body (validate +
 * write, dry-run + diff, etc.).
 *
 * @module core/design/scaffold
 */

/**
 * Raw GitHub base for awesome-design-md. Public, MIT licensed.
 * Each brand lives at `<base>/<slug>/DESIGN.md`.
 */
export const AWESOME_DESIGN_MD_RAW_BASE =
  "https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main";

/**
 * Empty 9-section DESIGN.md skeleton. Meant to be filled in
 * incrementally — Mandu's point is that DESIGN.md is a *living*
 * artifact, not a one-shot deliverable.
 */
export const EMPTY_DESIGN_MD = `# DESIGN.md

> Living design system spec for this project. AI agents and developers
> read this file before touching UI. See
> https://github.com/VoltAgent/awesome-design-md for examples.
>
> Fill sections incrementally — \`mandu design extract\` (coming soon)
> can propose tokens from your existing code.

## Visual Theme & Philosophy

<!-- One-paragraph "vibe": minimal, playful, dense, premium, … -->

## Color Palette

<!-- Each row: name — value — role.
- primary — #000000 — brand / primary action
- surface — #ffffff — page background
-->

## Typography

<!-- Each row: name — font-family / size / weight / line-height — usage.
- display — Inter, 48px, weight 700, line-height 1.1 — hero
- body — Inter, 16px, weight 400, line-height 1.6 — paragraphs
-->

## Components

<!-- One ### sub-heading per component. Declare variants as
\`variant: a | b | c\` so tools can index them.

### Button
variant: primary | secondary | ghost
size: sm | md | lg

### Card
variant: surface | bordered
-->

## Layout

<!-- Spacing scale + grid notes.
- xs — 4px
- sm — 8px
- md — 16px
- lg — 24px
- xl — 40px
-->

## Depth & Elevation

<!-- Shadow tokens.
- card: 0 1px 2px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.10)
- popover: 0 4px 12px rgba(0,0,0,.12)
-->

## Do's & Don'ts

<!-- Add rules under ### Do and ### Don't sub-headings.
Mandu's Guard rule can lift the don't items into \`forbidInlineClasses\`.

### Do
- Use design tokens.

### Don't
- Inline raw colour values.
-->


## Responsive

<!-- Breakpoints + scaling notes.
- mobile — 0–639px
- tablet — 640–1023px
- desktop — 1024px+
-->

## Agent Prompts

<!-- Ready-made prompts the agent should use when generating UI. Each
### sub-heading is one prompt; the body is passed verbatim.

### Page hero
Generate a hero section using \`display\` typography and \`primary\`
color tokens. Avoid inline shadow values; use the \`card\` shadow token.
-->
`;

export interface FetchUpstreamOptions {
  /** Override base URL (test fixtures, mirrors). */
  baseUrl?: string;
  /** AbortSignal so callers can cancel a slow fetch. */
  signal?: AbortSignal;
}

/**
 * Fetch a DESIGN.md from awesome-design-md by brand slug.
 * Throws on HTTP error — the caller (CLI command) catches and prints
 * a user-facing message rather than letting it bubble.
 */
export async function fetchUpstreamDesignMd(
  slugOrUrl: string,
  options: FetchUpstreamOptions = {},
): Promise<string> {
  const url = isAbsoluteUrl(slugOrUrl)
    ? slugOrUrl
    : `${options.baseUrl ?? AWESOME_DESIGN_MD_RAW_BASE}/${encodeURIComponent(slugOrUrl)}/DESIGN.md`;
  const res = await fetch(url, { signal: options.signal });
  if (!res.ok) {
    throw new Error(
      `fetchUpstreamDesignMd: GET ${url} → HTTP ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}

function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

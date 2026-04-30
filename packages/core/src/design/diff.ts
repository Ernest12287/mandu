/**
 * DESIGN.md upstream diff (Issue #245 M4 §3.5 external loop).
 *
 * Compare a local DESIGN.md against an upstream source (typically a
 * brand spec from awesome-design-md). The diff is computed at the
 * **structured-token level** — added / changed / removed entries per
 * section — so agents can patch only the sections the user wants to
 * sync without touching free-form prose.
 *
 * The diff is intentionally narrow: it ignores prose changes inside
 * `rawBody`, comment shifts, and heading wording differences. It
 * answers one question — "did the upstream catalog gain, change, or
 * drop a token compared to my local file?".
 */

import type { ColorToken, DesignSpec, ShadowToken, SpacingToken, TypographyToken } from "./types";

export interface DiffEntryAddedRemoved<T> {
  kind: "added" | "removed";
  name: string;
  token: T;
}

export interface DiffEntryChanged<T> {
  kind: "changed";
  name: string;
  before: T;
  after: T;
}

export type DiffEntry<T> =
  | DiffEntryAddedRemoved<T>
  | DiffEntryChanged<T>;

export interface DesignSpecDiff {
  /** Per-section diff arrays (only structured sections). */
  colorPalette: DiffEntry<ColorToken>[];
  typography: DiffEntry<TypographyToken>[];
  layout: DiffEntry<SpacingToken>[];
  shadows: DiffEntry<ShadowToken>[];
  /** Total count of differences across all sections — convenience. */
  totalChanges: number;
  /** Sections whose `present` flag flipped between local and upstream. */
  sectionPresenceChanged: string[];
}

/**
 * Compute the diff. Pure — accepts already-parsed specs so callers
 * own fetching / caching of the upstream source.
 */
export function diffDesignSpecs(local: DesignSpec, upstream: DesignSpec): DesignSpecDiff {
  const colorPalette = diffByName(
    local.sections["color-palette"].tokens,
    upstream.sections["color-palette"].tokens,
    (a, b) => a.value === b.value && a.role === b.role,
  );
  const typography = diffByName(
    local.sections.typography.tokens,
    upstream.sections.typography.tokens,
    (a, b) =>
      a.fontFamily === b.fontFamily &&
      a.size === b.size &&
      a.weight === b.weight &&
      a.lineHeight === b.lineHeight,
  );
  const layout = diffByName(
    local.sections.layout.tokens,
    upstream.sections.layout.tokens,
    (a, b) => a.value === b.value,
  );
  const shadows = diffByName(
    local.sections.shadows.tokens,
    upstream.sections.shadows.tokens,
    (a, b) => a.value === b.value,
  );

  const sectionPresenceChanged: string[] = [];
  for (const id of [
    "theme",
    "color-palette",
    "typography",
    "components",
    "layout",
    "shadows",
    "dos-donts",
    "responsive",
    "agent-prompts",
  ] as const) {
    if (local.sections[id].present !== upstream.sections[id].present) {
      sectionPresenceChanged.push(id);
    }
  }

  const totalChanges = colorPalette.length + typography.length + layout.length + shadows.length;
  return { colorPalette, typography, layout, shadows, totalChanges, sectionPresenceChanged };
}

interface NamedToken {
  name: string;
}

function diffByName<T extends NamedToken>(
  local: readonly T[],
  upstream: readonly T[],
  same: (a: T, b: T) => boolean,
): DiffEntry<T>[] {
  const localByKey = new Map<string, T>();
  for (const t of local) localByKey.set(slug(t.name), t);
  const upstreamByKey = new Map<string, T>();
  for (const t of upstream) upstreamByKey.set(slug(t.name), t);

  const entries: DiffEntry<T>[] = [];
  for (const [key, upstreamToken] of upstreamByKey) {
    const localToken = localByKey.get(key);
    if (!localToken) {
      entries.push({ kind: "added", name: upstreamToken.name, token: upstreamToken });
      continue;
    }
    if (!same(localToken, upstreamToken)) {
      entries.push({ kind: "changed", name: upstreamToken.name, before: localToken, after: upstreamToken });
    }
  }
  for (const [key, localToken] of localByKey) {
    if (!upstreamByKey.has(key)) {
      entries.push({ kind: "removed", name: localToken.name, token: localToken });
    }
  }
  return entries;
}

function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

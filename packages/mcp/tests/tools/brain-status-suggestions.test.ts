/**
 * mandu.brain.status — tier-keyed suggestions (#237 Concern 4).
 *
 * Covers:
 *   - openai tier → heal + doctor suggestion strings.
 *   - anthropic tier → same heal + doctor suggestions.
 *   - template tier (with login prompt) → login-upgrade suggestion.
 *   - unknown / empty tier → empty list (no spurious suggestions).
 *
 * Issue #235 follow-up — the local Ollama tier was removed; the resolver
 * now collapses every offline path to `template`.
 *
 * We test `buildBrainStatusSuggestions` directly so the tier → string
 * mapping is pinned without needing a credential store stub.
 */
import { describe, test, expect } from "bun:test";
import { buildBrainStatusSuggestions } from "../../src/tools/brain";

describe("mandu.brain.status — suggestions (#237 Concern 4)", () => {
  test("openai tier produces the heal + doctor suggestion strings", () => {
    const suggestions = buildBrainStatusSuggestions("openai");
    expect(suggestions.length).toBe(2);
    expect(
      suggestions.some(
        (s) =>
          s.includes("mandu.ate.heal") &&
          (s.includes("mandu.ate.run") || s.includes("mandu.ate.auto_pipeline")),
      ),
    ).toBe(true);
    expect(
      suggestions.some(
        (s) => s.includes("mandu.brain.doctor") && s.includes("mandu.guard.check"),
      ),
    ).toBe(true);
  });

  test("anthropic tier produces the heal + doctor suggestion strings", () => {
    const suggestions = buildBrainStatusSuggestions("anthropic");
    expect(suggestions.length).toBe(2);
    expect(suggestions.some((s) => s.includes("mandu.ate.heal"))).toBe(true);
    expect(suggestions.some((s) => s.includes("mandu.brain.doctor"))).toBe(
      true,
    );
  });

  test("template tier produces the login-upgrade suggestion", () => {
    const suggestions = buildBrainStatusSuggestions("template");
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toMatch(/mandu brain login/);
    expect(suggestions[0]).toMatch(/openai|anthropic/);
  });

  test("legacy ollama tier value yields no suggestions (tier removed in #235 follow-up)", () => {
    // Sanity check — even if some old caller hands us "ollama" we must
    // not reproduce the legacy login-upgrade copy targeted at the
    // removed local-LLM path.
    expect(buildBrainStatusSuggestions("ollama")).toEqual([]);
  });

  test("unknown tier returns an empty suggestion list (no spurious pointers)", () => {
    expect(buildBrainStatusSuggestions("")).toEqual([]);
    expect(buildBrainStatusSuggestions("something-else")).toEqual([]);
  });
});

/**
 * Google Gemini prompt adapter.
 *
 * Gemini REST API expects roles "user" / "model" (no "system" role) — a
 * system prompt is passed via `systemInstruction`. To keep the library
 * interface consistent we preserve the synthetic "system" role in the
 * returned messages; callers using @google/genai should read the first
 * "system" message off and pass it to `systemInstruction`.
 *
 * Historically Gemini also tolerated merging system into the first user
 * turn — we do NOT do that here because provider-specific mapping is the
 * SDK caller's responsibility.
 */

import type { PromptAdapter, PromptMessage } from "../types";

export const geminiAdapter: PromptAdapter = {
  name: "gemini",
  getDefaultUserCharBudget() {
    // Gemini 2.x supports 1M+ context; cap char budget at 40k for cost.
    return 40_000;
  },
  render(messages: PromptMessage[]): PromptMessage[] {
    const systems: string[] = [];
    const conversation: PromptMessage[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systems.push(msg.content);
        continue;
      }
      // Normalize assistant → "assistant" stays (callers map to "model").
      conversation.push(msg);
    }
    const out: PromptMessage[] = [];
    if (systems.length > 0) {
      out.push({ role: "system", content: systems.join("\n\n") });
    }
    out.push(...conversation);
    return out;
  },
};

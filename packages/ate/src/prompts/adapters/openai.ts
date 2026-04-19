/**
 * OpenAI prompt adapter (ChatGPT / GPT-4 chat completions).
 *
 * OpenAI messages API expects [{role, content}, ...] with roles
 * "system" | "user" | "assistant" — which is already our canonical
 * shape. We only merge duplicate leading system messages into one.
 */

import type { PromptAdapter, PromptMessage } from "../types";

export const openaiAdapter: PromptAdapter = {
  name: "openai",
  getDefaultUserCharBudget() {
    // gpt-4o / gpt-4-turbo default to 128k ctx; cap char portion at 50k.
    return 50_000;
  },
  render(messages: PromptMessage[]): PromptMessage[] {
    const out: PromptMessage[] = [];
    const systems: string[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systems.push(msg.content);
      } else {
        if (systems.length > 0) {
          out.push({ role: "system", content: systems.join("\n\n") });
          systems.length = 0;
        }
        out.push(msg);
      }
    }
    if (systems.length > 0) {
      // Only trailing system messages — unusual but keep order deterministic.
      out.unshift({ role: "system", content: systems.join("\n\n") });
    }
    return out;
  },
};

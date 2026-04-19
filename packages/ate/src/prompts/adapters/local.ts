/**
 * Local / generic prompt adapter (Ollama, LM Studio, llama.cpp, etc.).
 *
 * Most local runtimes accept OpenAI-compatible chat format, so we pass
 * through untouched. Systems are consolidated into a single leading
 * message for determinism.
 */

import type { PromptAdapter, PromptMessage } from "../types";

export const localAdapter: PromptAdapter = {
  name: "local",
  getDefaultUserCharBudget() {
    // Smaller local models usually target 8k–32k ctx; conservative cap.
    return 20_000;
  },
  render(messages: PromptMessage[]): PromptMessage[] {
    const systems: string[] = [];
    const conv: PromptMessage[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systems.push(msg.content);
      } else {
        conv.push(msg);
      }
    }
    const out: PromptMessage[] = [];
    if (systems.length > 0) {
      out.push({ role: "system", content: systems.join("\n\n") });
    }
    out.push(...conv);
    return out;
  },
};

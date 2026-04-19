/**
 * Claude (Anthropic) prompt adapter.
 *
 * Claude messages API expects:
 *   - system: top-level `system` string (NOT a message)
 *   - messages: alternating user / assistant turns
 *
 * We keep the system message in the returned array for library-level
 * composability; callers that hit the Claude SDK should peel it off via
 * `messages[0].role === "system"`.
 */

import type { PromptAdapter, PromptMessage } from "../types";

export const claudeAdapter: PromptAdapter = {
  name: "claude",
  getDefaultUserCharBudget() {
    // Claude Sonnet 4 / 4.5 default context window is comfortably large;
    // we cap at ~60k chars (~15k tokens) for speed + cost control.
    return 60_000;
  },
  render(messages: PromptMessage[]): PromptMessage[] {
    // Claude prefers a single system prompt + alternating user/assistant.
    // We collapse multiple system messages into one block.
    const systems: string[] = [];
    const conversation: PromptMessage[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systems.push(msg.content);
      } else {
        conversation.push(msg);
      }
    }
    const merged: PromptMessage[] = [];
    if (systems.length > 0) {
      merged.push({ role: "system", content: systems.join("\n\n") });
    }
    merged.push(...conversation);
    return merged;
  },
};

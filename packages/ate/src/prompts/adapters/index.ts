import type { PromptAdapter, PromptProvider } from "../types";
import { claudeAdapter } from "./claude";
import { openaiAdapter } from "./openai";
import { geminiAdapter } from "./gemini";
import { localAdapter } from "./local";

export { claudeAdapter, openaiAdapter, geminiAdapter, localAdapter };

const adapters: Record<PromptProvider, PromptAdapter> = {
  claude: claudeAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
  local: localAdapter,
};

/**
 * Get the adapter for a given provider. Unknown providers fall back to
 * the local adapter (pass-through).
 */
export function getAdapter(provider: PromptProvider): PromptAdapter {
  return adapters[provider] ?? localAdapter;
}

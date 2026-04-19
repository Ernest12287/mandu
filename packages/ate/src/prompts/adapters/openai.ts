/**
 * OpenAI prompt adapter (ChatGPT / GPT-4 chat completions).
 *
 * OpenAI messages API expects [{role, content}, ...] with roles
 * "system" | "user" | "assistant" — which is already our canonical
 * shape. We only merge duplicate leading system messages into one.
 *
 * Streaming uses the v1/chat/completions SSE endpoint.
 */

import type {
  PromptAdapter,
  PromptMessage,
  PromptStreamOptions,
  PromptStreamTerminal,
} from "../types";

const DEFAULT_MODEL = "gpt-4o-mini";

function maskKey(key: string): string {
  if (!key) return "sk-***";
  if (key.length <= 8) return "sk-***";
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

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
  async *stream(
    options: PromptStreamOptions,
  ): AsyncIterable<string | PromptStreamTerminal> {
    const apiKey = options.apiKey ?? process.env.MANDU_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("MANDU_OPENAI_API_KEY is not set");
    }

    const url = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "") + "/v1/chat/completions";

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: options.model ?? DEFAULT_MODEL,
          messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          max_tokens: options.maxTokens,
          stream_options: { include_usage: true },
        }),
        signal: options.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new Error(
        `openai stream failed (key=${maskKey(apiKey)}): ${(err as Error).message}`,
      );
    }

    if (!response.ok || !response.body) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `openai stream HTTP ${response.status}: ${bodyText.slice(0, 200) || response.statusText}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let produced = 0;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              produced += delta.length;
              yield delta;
            }
            if (parsed.usage) {
              tokensIn = parsed.usage.prompt_tokens;
              tokensOut = parsed.usage.completion_tokens;
            }
          } catch {
            /* ignore malformed SSE frame */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      tokensEstimated: Math.max(1, Math.ceil(produced / 4)),
      tokensIn,
      tokensOut,
    } satisfies PromptStreamTerminal;
  },
};

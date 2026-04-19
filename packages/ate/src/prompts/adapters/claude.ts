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
 *
 * Streaming uses the v1/messages SSE endpoint. Token accounting is parsed
 * from the terminal `message_delta` event when present.
 */

import type {
  PromptAdapter,
  PromptMessage,
  PromptStreamOptions,
  PromptStreamTerminal,
} from "../types";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

function maskKey(key: string): string {
  if (!key) return "sk-***";
  if (key.length <= 8) return "sk-***";
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

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
  async *stream(
    options: PromptStreamOptions,
  ): AsyncIterable<string | PromptStreamTerminal> {
    const apiKey = options.apiKey ?? process.env.MANDU_CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("MANDU_CLAUDE_API_KEY is not set");
    }

    const systems: string[] = [];
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const msg of options.messages) {
      if (msg.role === "system") systems.push(msg.content);
      else turns.push({ role: msg.role, content: msg.content });
    }

    const url = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages";

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: options.model ?? DEFAULT_MODEL,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: systems.length > 0 ? systems.join("\n\n") : undefined,
          messages: turns,
          stream: true,
        }),
        signal: options.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new Error(
        `claude stream failed (key=${maskKey(apiKey)}): ${(err as Error).message}`,
      );
    }

    if (!response.ok || !response.body) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `claude stream HTTP ${response.status}: ${bodyText.slice(0, 200) || response.statusText}`,
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
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          // Each frame is: "event: <name>\ndata: <json>"
          let dataLine = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) dataLine = line.slice(5).trim();
          }
          if (!dataLine || dataLine === "[DONE]") continue;
          try {
            const parsed = JSON.parse(dataLine) as {
              type?: string;
              delta?: { type?: string; text?: string; stop_reason?: string };
              usage?: { input_tokens?: number; output_tokens?: number };
              message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            };
            if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
              const text = parsed.delta.text ?? "";
              if (text.length > 0) {
                produced += text.length;
                yield text;
              }
            } else if (parsed.type === "message_start" && parsed.message?.usage) {
              tokensIn = parsed.message.usage.input_tokens;
            } else if (parsed.type === "message_delta" && parsed.usage) {
              tokensOut = parsed.usage.output_tokens;
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

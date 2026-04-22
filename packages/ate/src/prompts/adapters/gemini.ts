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
 *
 * Streaming uses the `generateContent` SSE endpoint (`streamGenerateContent`
 * with `alt=sse`).
 */

import type {
  PromptAdapter,
  PromptMessage,
  PromptStreamOptions,
  PromptStreamTerminal,
} from "../types";

const DEFAULT_MODEL = "gemini-2.0-flash";

function maskKey(key: string): string {
  if (!key) return "sk-***";
  if (key.length <= 8) return "sk-***";
  return `${key.slice(0, 3)}***${key.slice(-2)}`;
}

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
  async *stream(
    options: PromptStreamOptions,
  ): AsyncIterable<string | PromptStreamTerminal> {
    const apiKey = options.apiKey ?? process.env.MANDU_GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("MANDU_GEMINI_API_KEY is not set");
    }

    const systems: string[] = [];
    const turns: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
    for (const msg of options.messages) {
      if (msg.role === "system") {
        systems.push(msg.content);
      } else {
        turns.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }

    const model = options.model ?? DEFAULT_MODEL;
    const base = (options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    // Gemini expects the key as a query param. We keep it out of headers
    // so it never leaks into edge logs that scrub auth headers only.
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction:
            systems.length > 0
              ? { role: "system", parts: [{ text: systems.join("\n\n") }] }
              : undefined,
          contents: turns,
          generationConfig: options.maxTokens ? { maxOutputTokens: options.maxTokens } : undefined,
        }),
        signal: options.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new Error(
        `gemini stream failed (key=${maskKey(apiKey)}): ${(err as Error).message}`,
        { cause: err },
      );
    }

    if (!response.ok || !response.body) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `gemini stream HTTP ${response.status}: ${bodyText.slice(0, 200) || response.statusText}`,
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
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
              }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
              };
            };
            const parts = parsed.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const part of parts) {
                if (typeof part.text === "string" && part.text.length > 0) {
                  produced += part.text.length;
                  yield part.text;
                }
              }
            }
            if (parsed.usageMetadata) {
              tokensIn = parsed.usageMetadata.promptTokenCount;
              tokensOut = parsed.usageMetadata.candidatesTokenCount;
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

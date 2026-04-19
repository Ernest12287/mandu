/**
 * `mandu ai eval` — non-interactive prompt evaluator.
 *
 * Runs a single prompt against one or more providers in parallel and
 * emits a JSON diff table suitable for diff / CI snapshotting:
 *
 * ```json
 * {
 *   "prompt": "hello",
 *   "results": [
 *     { "provider": "local", "ok": true, "response": "...", "tokens": ..., "latency_ms": 12 },
 *     { "provider": "openai", "ok": false, "error": "MANDU_OPENAI_API_KEY is not set" }
 *   ]
 * }
 * ```
 *
 * Exit codes:
 *   0 — every provider succeeded
 *   1 — at least one provider failed
 *   2 — usage error (missing --prompt / unknown flag)
 */

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import type { CommandContext } from "../registry";
import type { PromptMessage, PromptProvider } from "@mandujs/ate/prompts";
import { CLI_ERROR_CODES, printCLIError } from "../../errors";
import {
  InvalidProviderError,
  MissingApiKeyError,
  PROVIDER_DEFAULT_MODEL,
  StreamTimeoutError,
  collectChat,
  resolveProvider,
  sanitizeUtf8Input,
} from "../../util/ai-client";
import { loadPreset, loadSystemFile } from "./chat";

export const EXIT_OK = 0;
export const EXIT_ERR = 1;
export const EXIT_USAGE = 2;

const EVAL_HELP = [
  "",
  "  mandu ai eval — non-interactive prompt eval",
  "",
  "  Required:",
  "    --prompt=<text>           Prompt literal",
  "    --prompt-file=<path>      Read prompt from file (UTF-8)",
  "",
  "  Optional:",
  "    --providers=<csv>         Comma-separated: claude,openai,gemini,local",
  "    --provider=<name>         Single provider shortcut (default: local)",
  "    --model=<id>              Override default model (single-provider only)",
  "    --system=<path>           Use file as system prompt",
  "    --preset=<name>           Use docs/prompts/<name>.md as system",
  "    --timeout=<ms>            Per-provider timeout (default: 60000)",
  "    --help                    Show this message",
  "",
  "  Output: JSON object written to stdout. Exit 0 if all providers",
  "  succeeded, 1 otherwise.",
  "",
].join("\n");

export interface EvalOptions {
  prompt?: string;
  promptFile?: string;
  providers?: string[];
  provider?: string;
  model?: string;
  systemPath?: string;
  preset?: string;
  timeoutMs?: number;
  cwd?: string;
  output?: NodeJS.WritableStream;
  help?: boolean;
}

export interface EvalResultRow {
  provider: PromptProvider;
  model: string;
  ok: boolean;
  response?: string;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
  tokens_estimated?: number;
  latency_ms?: number;
}

export interface EvalReport {
  prompt: string;
  system?: string;
  startedAt: string;
  results: EvalResultRow[];
}

/** Normalize CLI `--providers=foo,bar --provider=baz` into a deduped list. */
export function parseProviderList(opts: EvalOptions): PromptProvider[] {
  const fromCsv = (opts.providers ?? []).flatMap((p) =>
    p.split(",").map((s) => s.trim()).filter(Boolean),
  );
  const raw = fromCsv.length > 0 ? fromCsv : [opts.provider ?? "local"];
  const resolved: PromptProvider[] = [];
  const seen = new Set<string>();
  for (const name of raw) {
    const canonical = resolveProvider(name);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    resolved.push(canonical);
  }
  return resolved;
}

/** Run one provider; never throws — errors land in the result row. */
export async function evalOne(
  provider: PromptProvider,
  messages: PromptMessage[],
  options: { model?: string; timeoutMs?: number } = {},
): Promise<EvalResultRow> {
  const model = options.model ?? PROVIDER_DEFAULT_MODEL[provider];
  try {
    const { response, latencyMs, tokens } = await collectChat({
      provider,
      messages,
      model,
      timeoutMs: options.timeoutMs,
    });
    return {
      provider,
      model,
      ok: true,
      response,
      latency_ms: latencyMs,
      tokens_estimated: tokens.tokensEstimated,
      tokens_in: tokens.tokensIn,
      tokens_out: tokens.tokensOut,
    };
  } catch (err) {
    let message: string;
    if (err instanceof MissingApiKeyError) {
      message = `${err.envVar} is not set`;
    } else if (err instanceof StreamTimeoutError) {
      message = `timeout after ${err.timeoutMs}ms`;
    } else if (err instanceof InvalidProviderError) {
      message = `invalid provider ${err.provider}`;
    } else {
      message = (err as Error).message;
    }
    return { provider, model, ok: false, error: message };
  }
}

/**
 * CLI entry. Returns a numeric exit code (0, 1, 2).
 *
 * Accepts either a raw {@link CommandContext} (from the registry) or a
 * pre-parsed {@link EvalOptions} (from tests / programmatic callers).
 */
export async function aiEval(ctx: CommandContext | EvalOptions): Promise<number> {
  const opts = normalizeOptions(ctx);
  const output = opts.output ?? process.stdout;
  const cwd = opts.cwd ?? process.cwd();

  if (opts.help) {
    output.write(EVAL_HELP);
    return EXIT_OK;
  }

  // Resolve the prompt text.
  let promptText: string;
  if (opts.promptFile) {
    const resolved = path.resolve(opts.promptFile);
    if (!existsSync(resolved)) {
      printCLIError(CLI_ERROR_CODES.AI_PROMPT_REQUIRED, {});
      output.write(`(prompt file not found: ${resolved})\n`);
      return EXIT_USAGE;
    }
    promptText = await fs.readFile(resolved, "utf8");
  } else if (opts.prompt && opts.prompt.trim().length > 0) {
    promptText = opts.prompt;
  } else {
    printCLIError(CLI_ERROR_CODES.AI_PROMPT_REQUIRED, {});
    return EXIT_USAGE;
  }

  try {
    promptText = sanitizeUtf8Input(promptText);
  } catch (err) {
    printCLIError(CLI_ERROR_CODES.AI_INVALID_INPUT, { reason: (err as Error).message });
    return EXIT_USAGE;
  }

  // Resolve system prompt (optional).
  let system: string | undefined;
  if (opts.preset) {
    try {
      const loaded = await loadPreset(opts.preset, cwd);
      system = loaded.text;
    } catch (err) {
      if ((err as { code?: string }).code === "AI_PRESET_NOT_FOUND") {
        printCLIError(CLI_ERROR_CODES.AI_PRESET_NOT_FOUND, { preset: opts.preset });
        return EXIT_ERR;
      }
      throw err;
    }
  } else if (opts.systemPath) {
    try {
      system = await loadSystemFile(opts.systemPath);
    } catch (err) {
      if ((err as { code?: string }).code === "AI_SYSTEM_FILE_NOT_FOUND") {
        printCLIError(CLI_ERROR_CODES.AI_SYSTEM_FILE_NOT_FOUND, { path: opts.systemPath });
        return EXIT_ERR;
      }
      throw err;
    }
  }

  // Determine provider list.
  let providers: PromptProvider[];
  try {
    providers = parseProviderList(opts);
  } catch (err) {
    if (err instanceof InvalidProviderError) {
      printCLIError(CLI_ERROR_CODES.AI_UNKNOWN_PROVIDER, { provider: err.provider });
      return EXIT_USAGE;
    }
    throw err;
  }
  if (providers.length === 0) providers = ["local"];

  const messages: PromptMessage[] = [];
  if (system && system.trim().length > 0) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: promptText });

  // Run providers in parallel. If only one is supplied, honor --model.
  const singleModelOverride = providers.length === 1 ? opts.model : undefined;
  const rows = await Promise.all(
    providers.map((p) =>
      evalOne(p, messages, {
        model: singleModelOverride,
        timeoutMs: opts.timeoutMs,
      }),
    ),
  );

  const report: EvalReport = {
    prompt: promptText,
    system,
    startedAt: new Date().toISOString(),
    results: rows,
  };
  output.write(JSON.stringify(report, null, 2) + "\n");

  const allOk = rows.every((r) => r.ok);
  return allOk ? EXIT_OK : EXIT_ERR;
}

function normalizeOptions(ctx: CommandContext | EvalOptions): EvalOptions {
  if (!ctx || typeof ctx !== "object") return {};
  if (!("options" in ctx) || !("args" in ctx)) {
    return ctx as EvalOptions;
  }
  const cc = ctx as CommandContext;
  const opts = cc.options ?? {};
  const rawProvider = typeof opts.provider === "string" && opts.provider !== "true" ? opts.provider : undefined;
  const rawProviders = typeof opts.providers === "string" && opts.providers !== "true" ? opts.providers : undefined;
  const rawModel = typeof opts.model === "string" && opts.model !== "true" ? opts.model : undefined;
  const rawPrompt = typeof opts.prompt === "string" && opts.prompt !== "true" ? opts.prompt : undefined;
  const rawPromptFile =
    typeof opts["prompt-file"] === "string" && opts["prompt-file"] !== "true"
      ? opts["prompt-file"]
      : undefined;
  const rawSystem = typeof opts.system === "string" && opts.system !== "true" ? opts.system : undefined;
  const rawPreset = typeof opts.preset === "string" && opts.preset !== "true" ? opts.preset : undefined;
  const rawTimeout = typeof opts.timeout === "string" && opts.timeout !== "true" ? Number(opts.timeout) : undefined;
  const help =
    opts.help === "true" || opts.help === "" || (cc.args ?? []).includes("--help");
  return {
    prompt: rawPrompt,
    promptFile: rawPromptFile,
    providers: rawProviders ? [rawProviders] : undefined,
    provider: rawProvider,
    model: rawModel,
    systemPath: rawSystem,
    preset: rawPreset,
    timeoutMs: Number.isFinite(rawTimeout) ? rawTimeout : undefined,
    help,
  };
}

/**
 * `mandu ai` — top-level dispatcher for the AI chat playground (Phase 14.2).
 *
 * Subcommands:
 *   - `chat`  — interactive streaming REPL (defaults to `local` provider)
 *   - `eval`  — non-interactive single-prompt evaluator across providers
 *
 * Exit codes (stable):
 *   0 — success
 *   1 — error (network / auth / abort / validation)
 *   2 — usage (unknown subcommand / missing args)
 *
 * Help is printed when the user runs `mandu ai` with no subcommand or
 * `mandu ai --help`.
 */

import type { CommandContext } from "./registry";

export const AI_SUBCOMMANDS = ["chat", "eval"] as const;
export type AiSubcommand = (typeof AI_SUBCOMMANDS)[number];

export const AI_HELP = [
  "",
  "  mandu ai — terminal AI playground (Phase 14.2)",
  "",
  "  Subcommands:",
  "    chat     Interactive streaming chat (--provider=local|claude|openai|gemini)",
  "    eval     Non-interactive prompt eval → JSON diff table",
  "",
  "  Common flags:",
  "    --provider=<name>       Provider to use (default: local)",
  "    --model=<id>            Override the provider's default model",
  "    --system=<path>         Use <path> as the system prompt (UTF-8 text)",
  "    --preset=<name>         Load docs/prompts/<name>.md as system",
  "    --help                  Show this message",
  "",
  "  Secrets:",
  "    MANDU_CLAUDE_API_KEY, MANDU_OPENAI_API_KEY, MANDU_GEMINI_API_KEY",
  "    (read-only; NEVER printed. Use --provider=local to work offline.)",
  "",
  "  Examples:",
  "    mandu ai chat --provider=local --preset=system",
  "    mandu ai chat --provider=claude --model=claude-sonnet-4-20250514",
  "    mandu ai eval --provider=local --prompt=\"hello\"",
  "    mandu ai eval --prompt-file=prompt.txt --providers=local,openai",
  "",
].join("\n");

/**
 * Dispatch `mandu ai <sub>`. Always resolves numerically and the caller
 * (registry) never needs to know about exit codes — on success we return
 * `true`, on any failure we `process.exit(code)`.
 */
export async function aiDispatch(ctx: CommandContext): Promise<boolean> {
  const sub = ctx.args[1];
  if (!sub || sub.startsWith("--") || sub === "help") {
    // Explicit help or no subcommand → print help + succeed (so the parent
    // CLI doesn't then print a second "unknown subcommand" error).
    process.stdout.write(AI_HELP);
    return true;
  }

  switch (sub) {
    case "chat": {
      const { aiChat } = await import("./ai/chat");
      const code = await aiChat(ctx);
      process.exit(code);
      return true;
    }
    case "eval": {
      const { aiEval } = await import("./ai/eval");
      const code = await aiEval(ctx);
      process.exit(code);
      return true;
    }
    default:
      process.stderr.write(
        `mandu ai: unknown subcommand "${sub}". Try one of: ${AI_SUBCOMMANDS.join(", ")}\n`,
      );
      return false;
  }
}

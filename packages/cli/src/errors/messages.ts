import { readFileSync } from "node:fs";
import path from "node:path";
import { renderMarkdown } from "../cli-ux/markdown.js";
import { CLI_ERROR_CODES, type CLIErrorCode } from "./codes";

interface ErrorInfo {
  message: string;
  suggestion?: string;
  docLink?: string;
  /**
   * When provided, resolves to a markdown template file under
   * `packages/cli/templates/errors/<code>.md`. The template is
   * rendered via `renderMarkdown()` and fully replaces the legacy
   * 3-line fixed format. Falls back to the legacy format when the
   * template file is missing or unreadable.
   */
  template?: string;
}

export const ERROR_MESSAGES: Record<CLIErrorCode, ErrorInfo> = {
  [CLI_ERROR_CODES.INIT_DIR_EXISTS]: {
    message: "Directory already exists: {path}",
    suggestion: "Choose a different project name or remove the existing directory.",
    template: "CLI_E001",
  },
  [CLI_ERROR_CODES.INIT_BUN_NOT_FOUND]: {
    message: "Bun runtime not found.",
    suggestion: "Install Bun and ensure it is available in your PATH.",
  },
  [CLI_ERROR_CODES.INIT_TEMPLATE_NOT_FOUND]: {
    message: "Template not found: {template}",
    suggestion: "Use a valid template name (default).",
  },
  [CLI_ERROR_CODES.DEV_PORT_IN_USE]: {
    message: "Port {port} is already in use.",
    suggestion: "Set PORT or mandu.config server.port to pick a different port, or stop the process using this port.",
    template: "CLI_E010",
  },
  [CLI_ERROR_CODES.DEV_MANIFEST_NOT_FOUND]: {
    message: "Routes manifest not found.",
    suggestion: "Run `mandu routes generate` or create app/ routes before dev.",
  },
  [CLI_ERROR_CODES.DEV_NO_ROUTES]: {
    message: "No routes were found in app/.",
    suggestion: "Create app/page.tsx or app/api/*/route.ts to get started.",
  },
  [CLI_ERROR_CODES.GUARD_CONFIG_INVALID]: {
    message: "Invalid guard configuration.",
    suggestion: "Check your mandu.config and guard settings.",
  },
  [CLI_ERROR_CODES.GUARD_PRESET_NOT_FOUND]: {
    message: "Unknown architecture preset: {preset}",
    suggestion: "Available presets: mandu, fsd, clean, hexagonal, atomic.",
  },
  [CLI_ERROR_CODES.GUARD_VIOLATION_FOUND]: {
    message: "{count} architecture violation(s) found.",
    suggestion: "Fix violations above or set MANDU_OUTPUT=agent for AI-friendly output.",
    template: "CLI_E022",
  },
  [CLI_ERROR_CODES.BUILD_ENTRY_NOT_FOUND]: {
    message: "Build entry not found: {entry}",
    suggestion: "Check your routes manifest or build inputs.",
  },
  [CLI_ERROR_CODES.BUILD_BUNDLE_FAILED]: {
    message: "Bundle build failed for '{target}'.",
    suggestion: "Review build errors above for missing deps or syntax errors.",
  },
  [CLI_ERROR_CODES.BUILD_OUTDIR_NOT_WRITABLE]: {
    message: "Output directory is not writable: {path}",
    suggestion: "Ensure the directory exists and you have write permissions.",
  },
  [CLI_ERROR_CODES.CONFIG_PARSE_FAILED]: {
    message: "Failed to parse mandu.config.",
    suggestion: "Fix syntax errors in the config file.",
  },
  [CLI_ERROR_CODES.CONFIG_VALIDATION_FAILED]: {
    message: "Configuration validation failed.",
    suggestion: "Review validation errors above and fix your config.",
  },
  [CLI_ERROR_CODES.UNKNOWN_COMMAND]: {
    message: "Unknown command: {command}",
    suggestion: "Run with --help to see available commands.",
  },
  [CLI_ERROR_CODES.UNKNOWN_SUBCOMMAND]: {
    message: "Unknown subcommand '{subcommand}' for {command}.",
    suggestion: "Run the command with --help to see available subcommands.",
  },
  [CLI_ERROR_CODES.MISSING_ARGUMENT]: {
    message: "Missing required argument: {argument}",
    suggestion: "Provide the required argument and try again.",
  },
};

function interpolate(text: string, context?: Record<string, string | number>): string {
  if (!context) return text;
  let result = text;
  for (const [key, value] of Object.entries(context)) {
    // Support both legacy {key} and markdown {{key}} placeholder styles.
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
  }
  return result;
}

/**
 * Resolve the directory that contains markdown error templates.
 * Uses `import.meta.dir` so the path survives bundling into `dist/`.
 */
function getErrorTemplatesDir(): string {
  // packages/cli/src/errors → templates/errors
  return path.resolve(import.meta.dir, "..", "..", "templates", "errors");
}

function loadTemplate(code: string): string | null {
  try {
    const filePath = path.join(getErrorTemplatesDir(), `${code}.md`);
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function formatLegacy(
  code: CLIErrorCode,
  info: ErrorInfo | undefined,
  context?: Record<string, string | number>
): string {
  const message = interpolate(info?.message ?? "Unknown error", context);
  const suggestion = info?.suggestion ? interpolate(info.suggestion, context) : undefined;

  const lines = ["", `❌ Error [${code}]`, `   ${message}`];
  if (suggestion) {
    lines.push("", `💡 ${suggestion}`);
  }
  if (info?.docLink) {
    lines.push(`📖 ${info.docLink}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Format a CLI error for human display.
 *
 * External signature is stable — all call sites continue to receive a
 * plain string. Internally we now look up an optional markdown template
 * (`templates/errors/<CODE>.md`), interpolate `{{placeholders}}`, and
 * pipe the result through `renderMarkdown()` so the output adapts to
 * the terminal (ANSI in TTY, plain text under NO_COLOR / CI / pipes).
 *
 * When no template is registered for a code, we fall back to the
 * legacy 3-line format so nothing regresses.
 */
export function formatCLIError(
  code: CLIErrorCode,
  context?: Record<string, string | number>
): string {
  const info = ERROR_MESSAGES[code];
  const templateName = info?.template;

  if (templateName) {
    const raw = loadTemplate(templateName);
    if (raw) {
      const interpolated = interpolate(raw, {
        ...(context ?? {}),
        message: interpolate(info?.message ?? "", context),
        title: `${code}`,
      });
      try {
        const rendered = renderMarkdown(interpolated);
        return `\n${rendered}\n`;
      } catch {
        // Fall through to legacy format on any unexpected renderer failure.
      }
    }
  }

  return formatLegacy(code, info, context);
}

export class CLIError extends Error {
  readonly code: CLIErrorCode;
  readonly context?: Record<string, string | number>;

  constructor(code: CLIErrorCode, context?: Record<string, string | number>) {
    super(formatCLIError(code, context));
    this.code = code;
    this.context = context;
    this.name = "CLIError";
  }
}

export function printCLIError(
  code: CLIErrorCode,
  context?: Record<string, string | number>
): void {
  console.error(formatCLIError(code, context));
}

export function handleCLIError(error: unknown): never {
  if (error instanceof CLIError) {
    console.error(error.message);
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error(`\n❌ Unexpected error: ${error.message}\n`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }

  console.error("\n❌ Unknown error occurred (non-Error thrown)\n");
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.error("Thrown value:", error);
  }
  process.exit(1);
}

/**
 * Phase A.3 — prompt composer.
 *
 * End-to-end helper that turns a `(kind, context)` pair into a single
 * ready-to-send-to-LLM string. Sits on top of:
 *
 *   - `prompt-loader.ts`    → loads the versioned Markdown template.
 *   - `exemplar-scanner.ts` → collects tagged test exemplars.
 *
 * The composer:
 *   1. Loads the template for `kind` (optionally pinning `version`).
 *   2. Selects 2-3 matching positive exemplars + (up to) 1 anti-exemplar.
 *   3. Replaces the `<!-- EXEMPLAR_SLOT -->` marker with a formatted
 *      "Examples / Anti-examples" section.
 *   4. Appends a "# Provided context" block with the serialized `context`
 *      object (JSON-pretty-printed, within a fenced code block).
 *
 * Returns:
 *   {
 *     prompt: string,          // the ready-to-send text
 *     sha256: string,          // sha256(template raw file)
 *     version: number,         // resolved template version
 *     exemplarCount: number,   // positive exemplars included
 *     antiCount: number,       // anti-exemplars included
 *     tokenEstimate: number,   // rough — chars / 4
 *   }
 *
 * The exemplar slot marker is optional — if a template doesn't include it,
 * we still emit exemplars (appended to the end) so the composer can't silently
 * drop them.
 */

import { loadPrompt, type LoadedPrompt, type LoadPromptOptions } from "./prompt-loader";
import {
  scanExemplars,
  type Exemplar,
  type ScanOptions,
} from "./exemplar-scanner";

export interface ComposePromptInput {
  /** Prompt kind ( matches the filename stem of `packages/ate/prompts/`). */
  kind: string;
  /** Structured context that will be JSON-rendered into the prompt. */
  context?: unknown;
  /** Pin to a specific version. Omit for the latest available. */
  version?: number;
  /** Override the prompts directory (tests). */
  promptsDir?: string;
  /** Override the exemplar scan root (default: repo root = cwd). */
  repoRoot?: string;
  /** Restrict exemplar scanning. */
  scanOptions?: ScanOptions;
  /** Pre-computed exemplars (tests — skip the file walk). */
  exemplars?: Exemplar[];
  /** Max positive exemplars to inject. Default 3. */
  maxPositive?: number;
  /** Max anti-exemplars to inject. Default 1. */
  maxAnti?: number;
}

export interface ComposedPrompt {
  prompt: string;
  sha256: string;
  version: number;
  kind: string;
  exemplarCount: number;
  antiCount: number;
  tokenEstimate: number;
  templatePath: string;
}

const EXEMPLAR_SLOT = "<!-- EXEMPLAR_SLOT -->";

export async function composePrompt(input: ComposePromptInput): Promise<ComposedPrompt> {
  const loaderOpts: LoadPromptOptions = input.promptsDir ? { dir: input.promptsDir } : {};
  const loaded = loadPrompt(input.kind, input.version, loaderOpts);

  // Gather exemplars. If the caller pre-supplied them, trust the input — this
  // keeps the composer pure for goldens / unit tests.
  let allExemplars: Exemplar[];
  if (input.exemplars) {
    allExemplars = input.exemplars;
  } else {
    const repoRoot = input.repoRoot ?? process.cwd();
    allExemplars = await scanExemplars(repoRoot, input.scanOptions ?? {});
  }

  const matching = allExemplars.filter((e) => e.kind === input.kind);
  const positives = matching.filter((e) => !e.anti);
  const antis = matching.filter((e) => e.anti);

  const maxPositive = input.maxPositive ?? 3;
  const maxAnti = input.maxAnti ?? 1;

  const pickedPositives = positives.slice(0, maxPositive);
  const pickedAntis = antis.slice(0, maxAnti);

  const exemplarBlock = renderExemplarBlock(pickedPositives, pickedAntis);
  const contextBlock = input.context !== undefined ? renderContextBlock(input.context) : "";

  let prompt = loaded.raw;
  if (prompt.includes(EXEMPLAR_SLOT)) {
    prompt = prompt.replace(EXEMPLAR_SLOT, exemplarBlock);
  } else {
    // No slot — append at the end so exemplars are never dropped.
    prompt = prompt.trimEnd() + "\n\n" + exemplarBlock + "\n";
  }

  if (contextBlock) {
    prompt = prompt.trimEnd() + "\n\n" + contextBlock + "\n";
  }

  return {
    prompt,
    sha256: loaded.sha256,
    version: loaded.frontmatter.version,
    kind: loaded.frontmatter.kind,
    exemplarCount: pickedPositives.length,
    antiCount: pickedAntis.length,
    tokenEstimate: Math.ceil(prompt.length / 4),
    templatePath: loaded.path,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ──────────────────────────────────────────────────────────────────────────

function renderExemplarBlock(positives: Exemplar[], antis: Exemplar[]): string {
  const parts: string[] = [];

  if (positives.length === 0 && antis.length === 0) {
    parts.push(
      "_No tagged exemplars available for this kind yet. Infer from the role " +
        "description and the provided context._"
    );
  }

  if (positives.length > 0) {
    parts.push("## Positive examples");
    parts.push("");
    for (const ex of positives) {
      parts.push(renderExemplar(ex));
      parts.push("");
    }
  }

  if (antis.length > 0) {
    parts.push("## Anti-examples — DO NOT do this");
    parts.push("");
    for (const ex of antis) {
      parts.push(renderExemplar(ex));
      parts.push("");
    }
  }

  return parts.join("\n").trimEnd();
}

function renderExemplar(ex: Exemplar): string {
  const tagLine = ex.tags.length ? ` tags: ${ex.tags.join(", ")}` : "";
  const reasonLine = ex.anti && ex.reason ? ` reason: "${ex.reason}"` : "";
  const depthLine = ex.depth ? ` depth: ${ex.depth}` : "";
  const header = `From \`${ex.path}:${ex.startLine}-${ex.endLine}\`${depthLine}${tagLine}${reasonLine}`;
  return `${header}\n\n\`\`\`ts\n${ex.code}\n\`\`\``;
}

function renderContextBlock(context: unknown): string {
  const json = JSON.stringify(context, null, 2);
  return `# Provided context\n\n\`\`\`json\n${json}\n\`\`\``;
}

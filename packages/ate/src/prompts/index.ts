/**
 * ATE Prompt Library — Public API.
 *
 *   promptFor({ kind, provider, context, target, budget })
 *
 * Produces a provider-formatted `PromptSpec` (messages + metadata)
 * suitable for any LLM SDK. Templates are versioned individually so
 * upgrades stay backwards-compatible — pin a version in your call site
 * if you want deterministic output.
 */

import type {
  PromptContext,
  PromptMessage,
  PromptSpec,
  PromptSpecInput,
} from "./types";
import { getTemplate, listKinds } from "./templates";
import { getAdapter } from "./adapters";

export type {
  PromptProvider,
  PromptKind,
  PromptMessage,
  PromptBudget,
  PromptContext,
  PromptSpecInput,
  PromptSpec,
  PromptTemplate,
  PromptAdapter,
  PromptStreamOptions,
  PromptStreamTerminal,
} from "./types";

export { listKinds };
export { loadProjectContext, renderContextAsXml } from "./context";
export {
  getAdapter,
  claudeAdapter,
  openaiAdapter,
  geminiAdapter,
  localAdapter,
  renderLocalDummy,
} from "./adapters";
export {
  unitTestTemplate,
  integrationTestTemplate,
  e2eTestTemplate,
  healTemplate,
  impactTemplate,
  getTemplate,
} from "./templates";

const SYSTEM_DOC_PREFIX = "<project_docs>";
const SYSTEM_DOC_SUFFIX = "</project_docs>";

function renderSystemDocs(ctx: PromptContext | undefined): string {
  if (!ctx?.systemDocs?.length) return "";
  const parts: string[] = [SYSTEM_DOC_PREFIX];
  for (const doc of ctx.systemDocs) {
    parts.push(`  <doc name="${escapeXmlAttr(doc.name)}"><![CDATA[${doc.content}]]></doc>`);
  }
  parts.push(SYSTEM_DOC_SUFFIX);
  return parts.join("\n");
}

function escapeXmlAttr(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}

/**
 * Smart truncation: cut content from the middle of the user prompt so
 * both the initial instruction and the source snippet survive. We keep
 * ~40% at the head and ~60% at the tail.
 */
function truncateUserPrompt(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head - 64; // leave room for ellipsis marker
  const omitted = input.length - head - tail;
  return `${input.slice(0, head)}\n\n<!-- truncated ${omitted} chars for token budget -->\n\n${input.slice(input.length - tail)}`;
}

/**
 * Build a provider-specific prompt spec.
 *
 * @example
 * ```ts
 * const spec = promptFor({
 *   kind: "unit-test",
 *   provider: "claude",
 *   context: loadProjectContext({ repoRoot }),
 *   target: { id: "/api/users", path: "/api/users", methods: ["GET", "POST"] },
 * });
 * // Pass spec.messages straight to Anthropic SDK (peel off system first).
 * ```
 */
export function promptFor(input: PromptSpecInput): PromptSpec {
  if (!input || typeof input !== "object") {
    throw new Error("promptFor: input is required");
  }
  if (!input.kind) throw new Error("promptFor: kind is required");
  if (!input.provider) throw new Error("promptFor: provider is required");

  const template = getTemplate(input.kind);
  const adapter = getAdapter(input.provider);

  const system = input.overrides?.system ?? template.buildSystem(input.context ?? {});
  const userBase = input.overrides?.user ?? template.buildUser(input);

  // Attach systemDocs as a tail section of the system prompt so docs are
  // always immediately behind the system role (Claude cache-friendly).
  const docsBlock = renderSystemDocs(input.context);
  const systemFinal = docsBlock ? `${system}\n\n${docsBlock}` : system;

  const charBudget = input.budget?.maxUserChars ?? adapter.getDefaultUserCharBudget();
  const userFinal = truncateUserPrompt(userBase, charBudget);

  const raw: PromptMessage[] = [
    { role: "system", content: systemFinal },
    { role: "user", content: userFinal },
  ];

  const messages = adapter.render(raw);
  const charCount = messages.reduce((acc, m) => acc + m.content.length, 0);

  return {
    version: template.version,
    kind: template.kind,
    provider: input.provider,
    messages,
    system: systemFinal,
    charCount,
    templateId: `${template.kind}@${template.version}`,
  };
}

import type { PromptKind, PromptTemplate } from "../types";
import { unitTestTemplate } from "./unit-test";
import { integrationTestTemplate } from "./integration-test";
import { e2eTestTemplate } from "./e2e-test";
import { healTemplate } from "./heal";
import { impactTemplate } from "./impact";

export {
  unitTestTemplate,
  integrationTestTemplate,
  e2eTestTemplate,
  healTemplate,
  impactTemplate,
};

const templates: Record<PromptKind, PromptTemplate> = {
  "unit-test": unitTestTemplate,
  "integration-test": integrationTestTemplate,
  "e2e-test": e2eTestTemplate,
  heal: healTemplate,
  impact: impactTemplate,
};

/**
 * Look up the template for a given kind.
 */
export function getTemplate(kind: PromptKind): PromptTemplate {
  const t = templates[kind];
  if (!t) {
    throw new Error(`Unknown prompt kind: ${kind}`);
  }
  return t;
}

/** List all registered prompt kinds. */
export function listKinds(): PromptKind[] {
  return Object.keys(templates) as PromptKind[];
}

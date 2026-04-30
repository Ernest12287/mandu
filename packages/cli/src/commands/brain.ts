/**
 * Mandu CLI - Brain Commands (legacy module shim).
 *
 * The Ollama / Mistral / Ministral local-LLM path was removed alongside
 * issue #235. The brain now resolves to one of:
 *
 *   - openai     (OAuth via @openai/codex)
 *   - anthropic  (OAuth via Mandu loopback flow)
 *   - template   (with login prompt — no LLM, deterministic templates)
 *
 * The `mandu brain status` and `mandu brain login/logout` commands all
 * live in `./brain-auth.ts`. This module is kept only so existing
 * consumers that imported `brainStatus` from "./brain" still resolve;
 * the implementation simply forwards to `brainAuthStatus`.
 */

import { brainAuthStatus } from "./brain-auth";

export interface BrainStatusOptions {
  /** Show verbose status */
  verbose?: boolean;
}

/**
 * Check Brain status. Forwards to the resolver-aware status command in
 * `brain-auth.ts`. Retained for backward-compatible imports.
 */
export async function brainStatus(
  options: BrainStatusOptions = {},
): Promise<boolean> {
  return brainAuthStatus({ verbose: options.verbose });
}

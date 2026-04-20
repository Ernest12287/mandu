/**
 * failure.v1 — structured diagnostics schema (Phase A.2).
 *
 * Source of truth for every failure ATE surfaces to an agent. The
 * native error objects produced by Playwright / bun:test are
 * **translated** into this shape rather than passed through; the
 * contract between ATE and its consumers is the JSON described here,
 * not the runner-specific error payloads.
 *
 * Roadmap reference: `docs/ate/roadmap-v2-agent-native.md` §4.4 +
 * the 2026-04-21 boost block at the top of §7 (flakeScore,
 * lastPassedAt, graphVersion, trace fields).
 *
 * Every failure shape shares these top-level fields:
 *
 *   status: "fail"                — always the literal "fail"
 *   kind: one of 8 discriminated  — see FailureKind
 *   detail: kind-specific payload — discriminated by `kind`
 *   healing: { auto, requires_llm, hint? }
 *   flakeScore: 0..1              — rolling pass/fail flip ratio
 *   lastPassedAt: string | null   — ISO-8601 of last green run
 *   graphVersion: string          — sha256 of (routeIds + contractIds + extractor-version)
 *   trace: { path?, screenshot?, dom? }
 *
 * The discriminated detail payloads mirror §4.4 of the roadmap.
 * Fields marked `.optional()` appear only when the extractor was able
 * to recover them from the underlying runner output.
 */
import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ────────────────────────────────────────────────────────────────────────────

/**
 * A mechanical change an auto-healer can apply without asking a user
 * or an LLM. `selector_replace` is the Phase A.2 primary; additional
 * action types (attribute_add, retry_with_backoff, ...) can be added
 * in later phases without a schema bump because `change` is a string.
 */
export const healActionSchema = z.object({
  change: z.string(),
  old: z.string().optional(),
  new: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /**
   * Free-form note the agent can surface to the user — e.g. "text
   * match + role=button". Keep short (< 120 chars by convention).
   */
  reason: z.string().optional(),
});

export type HealAction = z.infer<typeof healActionSchema>;

export const healingSchema = z.object({
  auto: z.array(healActionSchema),
  requires_llm: z.boolean(),
  hint: z.string().optional(),
});

export type Healing = z.infer<typeof healingSchema>;

export const traceArtifactsSchema = z.object({
  /**
   * Absolute path (or repo-relative POSIX) to the Playwright trace
   * zip, when one was captured. Populated per-failure-kind — some
   * runners (bun:test) do not produce trace files.
   */
  path: z.string().optional(),
  screenshot: z.string().optional(),
  dom: z.string().optional(),
});

export type TraceArtifacts = z.infer<typeof traceArtifactsSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Discriminated detail payloads — one per failure kind.
// ────────────────────────────────────────────────────────────────────────────

// 1. selector_drift — DOM selector vanished.
const selectorDriftDetail = z.object({
  old: z.string(),
  expectedAt: z
    .object({
      file: z.string(),
      line: z.number().int().nonnegative(),
    })
    .optional(),
  domCandidates: z
    .array(
      z.object({
        selector: z.string(),
        similarity: z.number().min(0).max(1),
        text: z.string().optional(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  contextDiff: z
    .object({
      added: z.array(z.string()).default([]),
      removed: z.array(z.string()).default([]),
    })
    .optional(),
});

// 2. contract_mismatch — response shape violated a contract.
const contractMismatchDetail = z.object({
  route: z.string(),
  method: z.string().optional(),
  status: z.number().optional(),
  expectedSchema: z.unknown().optional(),
  actualResponse: z.unknown().optional(),
  violations: z
    .array(
      z.object({
        path: z.string(),
        expected: z.string(),
        actual: z.string(),
      }),
    )
    .default([]),
});

// 3. redirect_unexpected — landed on a URL we didn't expect.
const redirectUnexpectedDetail = z.object({
  from: z.string(),
  expectedTo: z.string(),
  actualTo: z.string(),
  chain: z.array(z.string()).default([]),
  status: z.number().optional(),
});

// 4. hydration_timeout — island never reached data-hydrated state.
const hydrationTimeoutDetail = z.object({
  island: z.string(),
  waitedMs: z.number().int().nonnegative(),
  selector: z.string().optional(),
  suggestedTimeoutMs: z.number().int().nonnegative().optional(),
});

// 5. rate_limit_exceeded — 429 returned by the route under test.
const rateLimitExceededDetail = z.object({
  route: z.string(),
  status: z.literal(429),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  observedAttempts: z.number().int().nonnegative().optional(),
});

// 6. csrf_invalid — 403 from CSRF middleware.
const csrfInvalidDetail = z.object({
  route: z.string(),
  status: z.literal(403),
  reason: z.string().optional(),
});

// 7. fixture_missing — a named fixture couldn't be resolved.
const fixtureMissingDetail = z.object({
  fixtureName: z.string(),
  /**
   * Where the fixture was referenced — best-effort. Missing when the
   * runner did not emit enough source context to localize.
   */
  referencedAt: z
    .object({
      file: z.string(),
      line: z.number().int().nonnegative().optional(),
    })
    .optional(),
  suggestion: z.string().optional(),
});

// 8. semantic_divergence — expectSemantic claim was not satisfied.
const semanticDivergenceDetail = z.object({
  claim: z.string(),
  evidence: z.string().optional(),
  oraclePending: z.boolean().default(false),
});

// ────────────────────────────────────────────────────────────────────────────
// Top-level discriminated union.
// ────────────────────────────────────────────────────────────────────────────

const baseFailureFields = {
  status: z.literal("fail"),
  healing: healingSchema,
  flakeScore: z.number().min(0).max(1),
  lastPassedAt: z.string().nullable(),
  graphVersion: z.string(),
  trace: traceArtifactsSchema.default({}),
  /**
   * Canonical ISO-8601 UTC of the failing run. Optional for
   * backwards compat with callers that don't yet stamp timestamps.
   */
  observedAt: z.string().optional(),
  /**
   * Path (or logical id) of the spec that produced this failure. Used
   * by the flake detector + artifact store to cross-reference.
   */
  specPath: z.string().optional(),
  /**
   * Run id — opaque string matching the artifact-store folder.
   */
  runId: z.string().optional(),
  /**
   * Optional raw duration of the failing case in milliseconds.
   */
  durationMs: z.number().int().nonnegative().optional(),
};

export const failureV1Schema = z.discriminatedUnion("kind", [
  z.object({
    ...baseFailureFields,
    kind: z.literal("selector_drift"),
    detail: selectorDriftDetail,
  }),
  z.object({
    ...baseFailureFields,
    kind: z.literal("contract_mismatch"),
    detail: contractMismatchDetail,
  }),
  z.object({
    ...baseFailureFields,
    kind: z.literal("redirect_unexpected"),
    detail: redirectUnexpectedDetail,
  }),
  z.object({
    ...baseFailureFields,
    kind: z.literal("hydration_timeout"),
    detail: hydrationTimeoutDetail,
  }),
  z.object({
    ...baseFailureFields,
    kind: z.literal("rate_limit_exceeded"),
    detail: rateLimitExceededDetail,
  }),
  z.object({
    ...baseFailureFields,
    kind: z.literal("csrf_invalid"),
    detail: csrfInvalidDetail,
  }),
  z.object({
    ...baseFailureFields,
    kind: z.literal("fixture_missing"),
    detail: fixtureMissingDetail,
  }),
  z.object({
    ...baseFailureFields,
    kind: z.literal("semantic_divergence"),
    detail: semanticDivergenceDetail,
  }),
]);

/**
 * Agent-facing type — import as `FailureV1` from `@mandujs/ate`.
 */
export type FailureV1 = z.infer<typeof failureV1Schema>;

/**
 * Enumeration of every supported failure kind (keeps downstream
 * switch statements honest via exhaustive narrowing).
 */
export type FailureKind = FailureV1["kind"];

/**
 * Runtime validation handle — used by `mandu_ate_run` + tests to
 * assert we never emit an ill-shaped failure object.
 */
export const failure = {
  v1: {
    schema: failureV1Schema,
    parse: (input: unknown): FailureV1 => failureV1Schema.parse(input),
    safeParse: (input: unknown) => failureV1Schema.safeParse(input),
  },
} as const;

/**
 * List of canonical failure kinds. Keep in sync with the discriminated
 * union above — a zod discriminated union's option list is not easily
 * reachable at the type level, so we maintain this explicit tuple for
 * iteration (tests, MCP tool input enums).
 */
export const FAILURE_KINDS = [
  "selector_drift",
  "contract_mismatch",
  "redirect_unexpected",
  "hydration_timeout",
  "rate_limit_exceeded",
  "csrf_invalid",
  "fixture_missing",
  "semantic_divergence",
] as const satisfies ReadonlyArray<FailureKind>;

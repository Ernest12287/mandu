/**
 * Phase C.1 — Semantic Primitives (@mandujs/core/testing barrel).
 *
 * Mandu-specific assertion primitives that the generic Playwright / bun:test
 * vocabulary cannot express cleanly:
 *
 *   - `expectContract`      — Zod shape validation with strict/loose/drift
 *     modes and path-based `ignorePaths`. Replaces `JSON.stringify`
 *     comparisons.
 *   - `expectNavigation`    — redirect-chain capture for Playwright pages.
 *   - `waitForIsland`       — polls `data-island="<name>"`'s
 *     `data-hydrated`/`data-island-state` attribute. Short-circuits for
 *     `hydration:none` strategies.
 *   - `assertStreamBoundary`— consumes a streaming SSR response and counts
 *     `<!--$-->` / `<!--/$-->` boundary markers. Validates shell chunk
 *     byte budgets and tail chunk content.
 *   - `expectSemantic`      — agent-delegated oracle. Writes an entry to
 *     `.mandu/ate-oracle-queue.jsonl` for an agent to judge later. CI is
 *     never blocked (`MANDU_ATE_DETERMINISTIC_ONLY=1` skips queueing).
 *     `promoteVerdicts: true` option lets a previously-failed verdict
 *     become a deterministic fail on re-run.
 *
 * Spec: docs/ate/phase-c-spec.md §C.1.
 *
 * These primitives live in `@mandujs/core/testing` (not `@mandujs/ate`) so
 * they are usable in any Mandu project test file, with or without the ATE
 * MCP server.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// expectContract
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal structural type of a Zod schema. We don't import `zod` here —
 * the caller provides the schema and we only call `safeParse`. This keeps
 * `@mandujs/core/testing` free of a zod peer dep for consumers who don't
 * use it.
 */
/**
 * Structural type matching both real `zod` schemas and hand-rolled
 * fakes. We intentionally widen the `error.issues` shape to `unknown[]`
 * — the primitive normalizes each issue internally so the call sites
 * don't have to worry about Zod version drift.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ZodLikeSchema<T = unknown> {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: T;
    // Intentionally loose — see note above.
    error?: { issues: readonly unknown[] } | undefined;
  };
}

interface NormalizedIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
  expected?: string;
  received?: string;
}

function normalizeIssue(raw: unknown): NormalizedIssue {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const pathRaw = obj.path;
  const path: Array<string | number> = Array.isArray(pathRaw)
    ? (pathRaw.filter((p) => typeof p === "string" || typeof p === "number") as Array<
        string | number
      >)
    : [];
  return {
    path,
    message: typeof obj.message === "string" ? obj.message : "",
    ...(typeof obj.code === "string" ? { code: obj.code } : {}),
    ...(typeof obj.expected === "string" ? { expected: obj.expected } : {}),
    ...(typeof obj.received === "string" ? { received: obj.received } : {}),
  };
}

export type ContractMode = "strict" | "loose" | "drift-tolerant";

export interface ContractViolation {
  path: string;
  expected: string;
  actual: string;
  severity: "critical" | "warning";
}

export interface ExpectContractOptions {
  mode?: ContractMode;
  /**
   * Dot-notation paths to ignore. Use `.createdAt`, `.items[0].updatedAt`,
   * or `.user.id`. Matching is prefix-aware — `.user` ignores every
   * descendant field.
   */
  ignorePaths?: string[];
}

export interface ExpectContractResult {
  status: "pass" | "fail";
  violations: ContractViolation[];
}

/**
 * Validate `actual` against a Zod schema and surface structured
 * violations. Throws when `status === "fail"` unless `mode` is
 * `drift-tolerant`, which only records warnings.
 *
 * @example
 * ```ts
 * expectContract(await res.json(), SignupResponseSchema, {
 *   mode: "loose",
 *   ignorePaths: [".createdAt", ".user.id"],
 * });
 * ```
 */
export function expectContract<T>(
  actual: unknown,
  schema: ZodLikeSchema<T>,
  options: ExpectContractOptions = {},
): ExpectContractResult {
  const mode: ContractMode = options.mode ?? "strict";
  const ignore = options.ignorePaths ?? [];

  const result = schema.safeParse(actual);

  if (result.success) {
    // Strict mode: walk `actual` looking for keys not mentioned anywhere
    // in the schema. We can't introspect a Zod schema structurally without
    // the runtime — instead we round-trip through `safeParse`'s `data`
    // which a default Zod schema strips unknown keys from (unless the
    // schema uses `.passthrough()` / `.strict()`). If `data` shape differs
    // from `actual` in strict mode, we flag the extras.
    if (mode === "strict" && result.data !== undefined) {
      const extras = findExtraKeys("", actual, result.data, ignore);
      if (extras.length > 0) {
        const violations: ContractViolation[] = extras.map((e) => ({
          path: e,
          expected: "(not in schema)",
          actual: "extra key present",
          severity: "critical",
        }));
        throwViolations(violations, "strict");
        return { status: "fail", violations };
      }
    }
    return { status: "pass", violations: [] };
  }

  // safeParse failed — translate Zod issues to our violation shape.
  const rawIssues = result.error?.issues ?? [];
  const violations: ContractViolation[] = [];
  for (const raw of rawIssues) {
    const issue = normalizeIssue(raw);
    const path = pathToString(issue.path);
    if (isIgnored(path, ignore)) continue;

    // loose mode forgives extra-key errors (unrecognized keys) but keeps
    // `missing_required` + format violations.
    if (mode === "loose" && isExtraKeyIssue(issue)) continue;

    const severity: "critical" | "warning" =
      mode === "drift-tolerant" ? "warning" : "critical";
    violations.push({
      path,
      expected: issue.expected ?? issue.message,
      actual: issue.received ?? describeActual(actual, issue.path),
      severity,
    });
  }

  if (violations.length === 0) {
    return { status: "pass", violations: [] };
  }

  if (mode === "drift-tolerant") {
    // Warnings collected; no throw. Caller may log via
    // `mandu_ate_remember({ kind: "contract_drift" })`.
    return { status: "fail", violations };
  }

  throwViolations(violations, mode);
  return { status: "fail", violations };
}

function isExtraKeyIssue(issue: { code?: string; message?: string }): boolean {
  if (issue.code === "unrecognized_keys") return true;
  return /unrecognized key/i.test(issue.message ?? "");
}

function throwViolations(violations: ContractViolation[], mode: ContractMode): never {
  const summary = violations
    .slice(0, 5)
    .map((v) => `  - ${v.path}: expected ${v.expected}, got ${v.actual}`)
    .join("\n");
  const more = violations.length > 5 ? `\n  ... +${violations.length - 5} more` : "";
  throw new ContractAssertionError(
    `expectContract (${mode}) failed with ${violations.length} violation(s):\n${summary}${more}`,
    violations,
  );
}

export class ContractAssertionError extends Error {
  violations: ContractViolation[];
  constructor(message: string, violations: ContractViolation[]) {
    super(message);
    this.name = "ContractAssertionError";
    this.violations = violations;
  }
}

function pathToString(path: Array<string | number>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += `.${seg}`;
  }
  return out;
}

function isIgnored(path: string, ignore: string[]): boolean {
  for (const ign of ignore) {
    if (path === ign || path.startsWith(ign + ".") || path.startsWith(ign + "[")) {
      return true;
    }
  }
  return false;
}

function describeActual(actual: unknown, path: Array<string | number>): string {
  let cursor: unknown = actual;
  for (const seg of path) {
    if (cursor === null || cursor === undefined) return "undefined";
    cursor = (cursor as Record<string | number, unknown>)[seg as string];
  }
  if (cursor === null) return "null";
  if (cursor === undefined) return "undefined";
  if (typeof cursor === "object") return JSON.stringify(cursor).slice(0, 60);
  return JSON.stringify(cursor);
}

/**
 * Find keys present in `actual` that are NOT present in `parsed` — extra
 * keys Zod stripped during safeParse. Only used in strict mode.
 */
function findExtraKeys(
  prefix: string,
  actual: unknown,
  parsed: unknown,
  ignore: string[],
): string[] {
  const out: string[] = [];
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return out;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;

  const actualKeys = Object.keys(actual as Record<string, unknown>);
  const parsedKeys = new Set(Object.keys(parsed as Record<string, unknown>));

  for (const key of actualKeys) {
    const path = `${prefix}.${key}`;
    if (isIgnored(path, ignore)) continue;
    if (!parsedKeys.has(key)) {
      out.push(path);
      continue;
    }
    const aVal = (actual as Record<string, unknown>)[key];
    const pVal = (parsed as Record<string, unknown>)[key];
    if (
      aVal !== null &&
      typeof aVal === "object" &&
      !Array.isArray(aVal) &&
      pVal !== null &&
      typeof pVal === "object" &&
      !Array.isArray(pVal)
    ) {
      out.push(...findExtraKeys(path, aVal, pVal, ignore));
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// expectNavigation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal Playwright Page shape — we only touch the bits we need so
 * consumers can use `@playwright/test`'s `Page` without creating an
 * import coupling.
 */
export interface PlaywrightLikePage {
  url(): string;
  on(event: "framenavigated", listener: (frame: { url: () => string }) => void): void;
  off?(event: "framenavigated", listener: (frame: { url: () => string }) => void): void;
  waitForURL?(url: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  waitForLoadState?(state?: "load" | "networkidle" | "domcontentloaded", opts?: { timeout?: number }): Promise<void>;
}

export interface ExpectNavigationInput {
  from?: string;
  to: string | RegExp;
  /** Exact chain length — overrides `maxRedirects` when both set. */
  redirectCount?: number;
  /** ≤ — chain length must not exceed this. */
  maxRedirects?: number;
  /** Milliseconds to wait for the terminal URL to match. Default 5000. */
  timeoutMs?: number;
}

export interface ExpectNavigationResult {
  status: "pass";
  chain: string[];
  finalUrl: string;
}

/**
 * Validate a redirect chain. Installs a `framenavigated` listener before
 * asserting the final URL matches `to`. When `from` is given we assert
 * the starting URL matches first.
 *
 * Emits a structured `failure.v1` `redirect_unexpected` error on
 * mismatch — callers should wrap in try/catch to translate to their
 * runner's fail helper.
 */
export async function expectNavigation(
  page: PlaywrightLikePage,
  expectation: ExpectNavigationInput,
): Promise<ExpectNavigationResult> {
  const timeoutMs = expectation.timeoutMs ?? 5000;
  const chain: string[] = [];
  let firstUrl: string | null = null;

  const onNav = (frame: { url: () => string }) => {
    const u = frame.url();
    if (firstUrl === null) firstUrl = u;
    // Only append when the URL actually changes.
    if (chain.length === 0 || chain[chain.length - 1] !== u) {
      chain.push(u);
    }
  };
  page.on("framenavigated", onNav);

  try {
    // Seed the chain with the current URL before waiting, so synchronous
    // navigations are captured even if `framenavigated` fires before we
    // attach.
    const current = page.url();
    if (current) chain.push(current);

    if (page.waitForURL) {
      try {
        await page.waitForURL(expectation.to, { timeout: timeoutMs });
      } catch {
        // fall through — we'll diagnose below
      }
    } else {
      // Fallback poll when waitForURL isn't available (mock pages etc).
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (urlMatches(page.url(), expectation.to)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    const finalUrl = page.url();
    if (chain.length === 0 || chain[chain.length - 1] !== finalUrl) {
      chain.push(finalUrl);
    }

    // Validate `from`.
    if (expectation.from !== undefined) {
      const first = chain[0];
      if (first && !urlMatches(first, expectation.from)) {
        throw new NavigationAssertionError(
          `expectNavigation: starting URL mismatch. Expected ${expectation.from}, got ${first}`,
          { from: expectation.from, expectedTo: String(expectation.to), actualTo: finalUrl, chain },
        );
      }
    }

    // Validate final URL.
    if (!urlMatches(finalUrl, expectation.to)) {
      throw new NavigationAssertionError(
        `expectNavigation: terminal URL mismatch. Expected ${expectation.to}, got ${finalUrl}`,
        { from: expectation.from ?? "", expectedTo: String(expectation.to), actualTo: finalUrl, chain },
      );
    }

    // Validate chain length.
    // Redirect count excludes the starting URL itself when `from` is set.
    const chainHops = expectation.from !== undefined ? Math.max(0, chain.length - 1) : chain.length;
    if (expectation.redirectCount !== undefined && chainHops !== expectation.redirectCount) {
      throw new NavigationAssertionError(
        `expectNavigation: redirect count mismatch. Expected exactly ${expectation.redirectCount}, got ${chainHops}`,
        { from: expectation.from ?? "", expectedTo: String(expectation.to), actualTo: finalUrl, chain },
      );
    }
    if (expectation.maxRedirects !== undefined && chainHops > expectation.maxRedirects) {
      throw new NavigationAssertionError(
        `expectNavigation: redirect chain too long. Expected ≤ ${expectation.maxRedirects}, got ${chainHops}`,
        { from: expectation.from ?? "", expectedTo: String(expectation.to), actualTo: finalUrl, chain },
      );
    }

    return { status: "pass", chain, finalUrl };
  } finally {
    if (page.off) {
      try {
        page.off("framenavigated", onNav);
      } catch {
        // ignore
      }
    }
  }
}

export class NavigationAssertionError extends Error {
  /** Shape matches `failure.v1` `redirect_unexpected` detail. */
  detail: {
    from: string;
    expectedTo: string;
    actualTo: string;
    chain: string[];
  };
  kind = "redirect_unexpected" as const;
  constructor(
    message: string,
    detail: { from: string; expectedTo: string; actualTo: string; chain: string[] },
  ) {
    super(message);
    this.name = "NavigationAssertionError";
    this.detail = detail;
  }
}

function urlMatches(actual: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) return expected.test(actual);
  // String match — treat as substring OR exact. "/kr" should match
  // "http://localhost/kr" too.
  if (actual === expected) return true;
  try {
    const parsed = new URL(actual);
    if (parsed.pathname === expected) return true;
    if (parsed.pathname + parsed.search === expected) return true;
  } catch {
    // fall through
  }
  return actual.includes(expected);
}

// ────────────────────────────────────────────────────────────────────────────
// waitForIsland
// ────────────────────────────────────────────────────────────────────────────

export interface WaitForIslandOptions {
  timeoutMs?: number;
  /** "hydrated" (default) or "visible". "visible" only checks mount. */
  state?: "hydrated" | "visible";
  /**
   * Override how islands expose their strategy. When this returns
   * "none" we short-circuit and resolve immediately.
   */
  strategyOf?: (page: PlaywrightIslandPage, name: string) => Promise<"none" | "other" | null>;
}

export interface PlaywrightIslandPage {
  /**
   * Invoke a JS function in the browser context. We use
   * `page.evaluate(fn, arg)` — same signature as Playwright's `Page`.
   */
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
}

/**
 * Wait until `[data-island="<name>"]` is hydrated.
 *
 * `hydration:none` strategy islands resolve immediately (Mandu's SSR
 * emits `data-island-strategy="none"` for those — we check that first
 * and short-circuit).
 *
 * Primary signal: `data-hydrated="true"` attribute (the one emitted by
 * `@mandujs/core/client/hydrate`). Fallback: `data-island-state="hydrated"`.
 */
export async function waitForIsland(
  page: PlaywrightIslandPage,
  name: string,
  options: WaitForIslandOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const state = options.state ?? "hydrated";

  // Short-circuit for hydration:none islands.
  try {
    const strategy = await page.evaluate(
      (n: string) => {
        const el = document.querySelector(`[data-island="${n}"]`);
        if (!el) return null;
        const s = el.getAttribute("data-island-strategy");
        return s ?? null;
      },
      name,
    );
    if (strategy === "none") {
      return;
    }
  } catch {
    // fall through — evaluate may be unsupported in mocks
  }

  const deadline = Date.now() + timeoutMs;
  const pollInterval = 25;

  while (Date.now() < deadline) {
    try {
      const status = await page.evaluate(
        (args: { name: string; state: string }) => {
          const el = document.querySelector(`[data-island="${args.name}"]`);
          if (!el) return { mounted: false, hydrated: false };
          const mounted = true;
          if (args.state === "visible") return { mounted, hydrated: mounted };
          // primary
          if (el.getAttribute("data-hydrated") === "true") {
            return { mounted, hydrated: true };
          }
          // fallback
          if (el.getAttribute("data-island-state") === "hydrated") {
            return { mounted, hydrated: true };
          }
          return { mounted, hydrated: false };
        },
        { name, state },
      );
      if (state === "visible" && status.mounted) return;
      if (status.hydrated) return;
    } catch {
      // evaluate failure — treat as not-yet-ready and retry.
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new HydrationTimeoutError(
    `waitForIsland: island "${name}" did not reach state=${state} within ${timeoutMs}ms`,
    { island: name, waitedMs: timeoutMs },
  );
}

export class HydrationTimeoutError extends Error {
  kind = "hydration_timeout" as const;
  detail: { island: string; waitedMs: number };
  constructor(message: string, detail: { island: string; waitedMs: number }) {
    super(message);
    this.name = "HydrationTimeoutError";
    this.detail = detail;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// assertStreamBoundary
// ────────────────────────────────────────────────────────────────────────────

export interface AssertStreamBoundaryInput {
  /** Substrings the FIRST decoded chunk must contain (all of them). */
  shellChunkContains?: string[];
  /** Exact count of `<!--$-->` / `<!--/$-->` pairs. */
  boundaryCount?: number;
  /** First-chunk size guard (bytes). */
  firstChunkMaxSizeBytes?: number;
  /** Any one of these strings must appear in the final chunk. */
  tailChunkContainsAnyOf?: string[];
}

export interface AssertStreamBoundaryResult {
  status: "pass";
  chunks: number;
  totalBytes: number;
  boundaryOpenCount: number;
  boundaryCloseCount: number;
}

/**
 * Consume a streaming Response chunk-by-chunk and validate boundary
 * markers / shell content / byte budgets.
 *
 * Throws `StreamBoundaryError` (failure.v1-shaped) on mismatch.
 */
export async function assertStreamBoundary(
  response: Response,
  expectations: AssertStreamBoundaryInput,
): Promise<AssertStreamBoundaryResult> {
  const body = response.body;
  if (!body) {
    throw new StreamBoundaryError("assertStreamBoundary: response has no body", {
      reason: "no_body",
    });
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: string[] = [];
  let totalBytes = 0;
  let firstChunkBytes = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = value.byteLength;
      totalBytes += bytes;
      if (chunks.length === 0) firstChunkBytes = bytes;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // flush trailing decoder state
    chunks.push(decoder.decode());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  const shell = chunks[0] ?? "";
  // Walk back to find the last non-empty chunk. The TextDecoder's final
  // flush can append an empty string — that would give us a useless tail.
  let tail = "";
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i] && chunks[i].length > 0) {
      tail = chunks[i];
      break;
    }
  }
  if (!tail) tail = chunks.join("");
  const full = chunks.join("");

  // shellChunkContains
  if (expectations.shellChunkContains) {
    for (const needle of expectations.shellChunkContains) {
      if (!shell.includes(needle)) {
        throw new StreamBoundaryError(
          `assertStreamBoundary: first chunk missing expected content "${needle}"`,
          {
            reason: "shell_missing_content",
            missing: needle,
            shellPreview: shell.slice(0, 200),
          },
        );
      }
    }
  }

  // firstChunkMaxSizeBytes
  if (
    expectations.firstChunkMaxSizeBytes !== undefined &&
    firstChunkBytes > expectations.firstChunkMaxSizeBytes
  ) {
    throw new StreamBoundaryError(
      `assertStreamBoundary: first chunk ${firstChunkBytes} bytes exceeds budget ${expectations.firstChunkMaxSizeBytes}`,
      {
        reason: "shell_over_budget",
        firstChunkBytes,
        budget: expectations.firstChunkMaxSizeBytes,
      },
    );
  }

  // boundary count — count occurrences of `<!--$-->` (open) and
  // `<!--/$-->` (close). A "boundary" is one open+close pair, so we
  // expect the open count to equal the close count AND equal
  // `expectations.boundaryCount`.
  const openCount = countOccurrences(full, "<!--$-->");
  const closeCount = countOccurrences(full, "<!--/$-->");
  if (
    expectations.boundaryCount !== undefined &&
    openCount !== expectations.boundaryCount
  ) {
    throw new StreamBoundaryError(
      `assertStreamBoundary: expected ${expectations.boundaryCount} Suspense boundaries, saw ${openCount} open / ${closeCount} close`,
      { reason: "boundary_count_mismatch", expected: expectations.boundaryCount, openCount, closeCount },
    );
  }

  // tailChunkContainsAnyOf
  if (expectations.tailChunkContainsAnyOf && expectations.tailChunkContainsAnyOf.length > 0) {
    const hit = expectations.tailChunkContainsAnyOf.some((n) => tail.includes(n));
    if (!hit) {
      throw new StreamBoundaryError(
        `assertStreamBoundary: tail chunk missing any of [${expectations.tailChunkContainsAnyOf.join(", ")}]`,
        {
          reason: "tail_missing_content",
          candidates: expectations.tailChunkContainsAnyOf,
          tailPreview: tail.slice(-200),
        },
      );
    }
  }

  return {
    status: "pass",
    chunks: chunks.length,
    totalBytes,
    boundaryOpenCount: openCount,
    boundaryCloseCount: closeCount,
  };
}

export class StreamBoundaryError extends Error {
  kind = "stream_boundary_mismatch" as const;
  detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = "StreamBoundaryError";
    this.detail = detail;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// ────────────────────────────────────────────────────────────────────────────
// expectSemantic — agent-delegated oracle
// ────────────────────────────────────────────────────────────────────────────

export interface ExpectSemanticOptions {
  /** What to capture. Default "both". */
  capture?: "screenshot" | "dom" | "both";
  /** Treat the queueing as non-blocking (default). */
  deferToAgent?: boolean;
  /**
   * When true, past `failed` verdicts for the same claim promote to a
   * deterministic fail on this run. Default false. Per §C.1.5.
   */
  promoteVerdicts?: boolean;
  /** Override the repo root — default `process.cwd()`. */
  repoRoot?: string;
  /** Override the spec path recorded in the queue entry. */
  specPath?: string;
  /** Override the runId recorded in the queue entry. */
  runId?: string;
  /** Inject a fixed timestamp — for goldens / tests. */
  now?: () => string;
  /**
   * Optional DOM snapshot — tests pass it in explicitly so we don't have
   * to stand up a headless browser. In real use this is captured via
   * `page.content()`.
   */
  domSnapshot?: string;
  /**
   * Optional screenshot bytes — tests pass it in explicitly so we don't
   * require Playwright at callers.
   */
  screenshotBytes?: Uint8Array;
}

export interface ExpectSemanticPage {
  /** Playwright Page.content(). */
  content?(): Promise<string>;
  /** Playwright Page.screenshot() — returns binary. */
  screenshot?(opts?: Record<string, unknown>): Promise<Uint8Array>;
}

export interface OracleQueueEntry {
  assertionId: string;
  specPath: string;
  runId: string;
  claim: string;
  artifactPath: string;
  status: "pending" | "passed" | "failed";
  verdict?: {
    judgedBy: "agent" | "human";
    reason: string;
    timestamp: string;
  };
  timestamp: string;
}

export interface ExpectSemanticResult {
  status: "pass" | "fail";
  assertionId: string;
  /** Set when a past verdict triggered a promoted deterministic fail. */
  promotedFromVerdict?: OracleQueueEntry["verdict"];
  /** True when we skipped queueing (CI / DETERMINISTIC_ONLY). */
  deferred: boolean;
}

/**
 * Queue a semantic claim for agent judgment.
 *
 * Default behaviour is **non-blocking** — we enqueue to
 * `.mandu/ate-oracle-queue.jsonl`, return `status: "pass"`, and let a
 * later agent session judge via `mandu_ate_oracle_verdict`.
 *
 * Two escape hatches:
 *   - `MANDU_ATE_DETERMINISTIC_ONLY=1` → no file writes, return immediately.
 *   - `promoteVerdicts: true` + past `failed` verdict for the same claim
 *     → throw `SemanticDivergenceError` to regress the spec.
 */
export function expectSemantic(
  page: ExpectSemanticPage,
  claim: string,
  options: ExpectSemanticOptions = {},
): ExpectSemanticResult {
  const repoRoot = options.repoRoot ?? process.cwd();
  const deterministicOnly = process.env.MANDU_ATE_DETERMINISTIC_ONLY === "1";

  // Compute a stable assertionId — hash of (claim + specPath). This is
  // how promoteVerdicts matches past verdicts without relying on random
  // ids.
  const specPath = options.specPath ?? inferSpecPath();
  const runId = options.runId ?? deriveRunId();
  const assertionId = stableAssertionId(claim, specPath);

  // promoteVerdicts — scan existing queue for the same assertionId.
  if (options.promoteVerdicts) {
    const past = findPastVerdict(repoRoot, assertionId);
    if (past && past.status === "failed" && past.verdict) {
      throw new SemanticDivergenceError(
        `expectSemantic: past verdict flagged this claim as failed. claim="${claim}" reason="${past.verdict.reason}"`,
        { claim, evidence: past.artifactPath, oraclePending: false },
      );
    }
  }

  if (deterministicOnly) {
    return {
      status: "pass",
      assertionId,
      deferred: true,
    };
  }

  // Create artifact dir + write captures.
  const nowStr = options.now ? options.now() : new Date().toISOString();
  const artifactDir = join(repoRoot, ".mandu", "ate-oracle-queue", runId, assertionId);
  try {
    mkdirSync(artifactDir, { recursive: true });
  } catch {
    // fall through — queue is best-effort
  }

  const capture = options.capture ?? "both";
  // Pull from explicit options first (test path), fall back to page calls.
  const domPromise =
    options.domSnapshot !== undefined
      ? Promise.resolve(options.domSnapshot)
      : capture === "screenshot" || !page.content
        ? Promise.resolve(null)
        : page.content().catch(() => null);
  const screenshotPromise =
    options.screenshotBytes !== undefined
      ? Promise.resolve(options.screenshotBytes)
      : capture === "dom" || !page.screenshot
        ? Promise.resolve(null)
        : page.screenshot().catch(() => null);

  // Write captures synchronously after they resolve. expectSemantic is
  // declared synchronous in §C.1.5 — but file writes here are also
  // expected to not block on network, so we kick off a microtask and
  // return. This matches the spec's "non-blocking for CI" contract.
  void Promise.all([domPromise, screenshotPromise]).then(([dom, shot]) => {
    try {
      if (dom !== null && dom !== undefined) {
        writeFileSync(join(artifactDir, "dom.html"), dom, "utf8");
      }
      if (shot) {
        writeFileSync(join(artifactDir, "screenshot.png"), Buffer.from(shot));
      }
    } catch {
      // swallow
    }
  });

  // Append the queue entry immediately so agents see it before the
  // artifacts finish writing.
  const entry: OracleQueueEntry = {
    assertionId,
    specPath,
    runId,
    claim,
    artifactPath: artifactDir.replace(/\\/g, "/"),
    status: "pending",
    timestamp: nowStr,
  };
  try {
    const queuePath = join(repoRoot, ".mandu", "ate-oracle-queue.jsonl");
    mkdirSync(dirname(queuePath), { recursive: true });
    appendFileSync(queuePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // swallow — queue write is best-effort.
  }

  return {
    status: "pass",
    assertionId,
    deferred: true,
  };
}

export class SemanticDivergenceError extends Error {
  kind = "semantic_divergence" as const;
  detail: { claim: string; evidence?: string; oraclePending: boolean };
  constructor(
    message: string,
    detail: { claim: string; evidence?: string; oraclePending: boolean },
  ) {
    super(message);
    this.name = "SemanticDivergenceError";
    this.detail = detail;
  }
}

function stableAssertionId(claim: string, specPath: string): string {
  // Small deterministic hash — DJB2 variant. Don't need cryptographic
  // strength; we just need stable ids across runs.
  const input = `${specPath}|${claim}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return `sem-${hash.toString(16).padStart(8, "0")}`;
}

function inferSpecPath(): string {
  // Best-effort: peek at the stack for the first frame outside this file.
  const err = new Error();
  const stack = err.stack ?? "";
  const lines = stack.split("\n");
  for (const line of lines) {
    if (line.includes("assertions.ts")) continue;
    const match = line.match(/\(([^)]+?):(\d+):(\d+)\)/) || line.match(/at\s+([^\s]+?):(\d+):(\d+)/);
    if (match) {
      const file = match[1];
      if (isAbsolute(file) && !file.includes("node_modules")) {
        return file.replace(/\\/g, "/");
      }
    }
  }
  return "unknown.spec.ts";
}

function deriveRunId(): string {
  return process.env.MANDU_ATE_RUN_ID ?? `run-${Date.now().toString(36)}`;
}

function findPastVerdict(repoRoot: string, assertionId: string): OracleQueueEntry | null {
  const path = join(repoRoot, ".mandu", "ate-oracle-queue.jsonl");
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8");
    // Walk from the tail — most recent verdict for this id wins.
    const lines = content.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as OracleQueueEntry;
        if (e.assertionId === assertionId && e.status !== "pending") {
          return e;
        }
      } catch {
        // skip corrupt line
      }
    }
  } catch {
    // swallow
  }
  return null;
}

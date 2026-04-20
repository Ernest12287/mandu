/**
 * Phase B.3 — Impact v2.
 *
 * Wraps `git diff --name-only` under 3 source modes, maps changed
 * files → affected routes / contracts via the spec index + interaction
 * graph, classifies contract diffs (additive | breaking | renaming),
 * and returns a full suggestion list per docs/ate/phase-b-spec.md §B.3.
 *
 * Backwards compatible with v1 `computeImpact` — the existing
 * `{ changedFiles, selectedRoutes, warnings }` fields are still
 * emitted. New callers read `affected`, `suggestions`, `changed`.
 *
 * Git invocation uses `Bun.spawn` per spec, with `node:child_process`
 * fallback (the package sets `engines.bun >=1.3.12`, but tests run
 * under Bun so this is fine in CI; the fallback handles the uncommon
 * case where the binding is unavailable).
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { getAtePaths, fileExists } from "../fs";
import { graphVersionFromGraph } from "../graph-version";
import { indexSpecs } from "../spec-indexer";
import { routeIdFromPath } from "../extractor-utils";
import type { InteractionGraph, InteractionNode } from "../types";
import { computeImpact as computeImpactV1 } from "../impact";

export type ImpactSince = "HEAD~1" | "staged" | "working" | string;

export interface ImpactV2Input {
  repoRoot: string;
  /**
   * What to diff against. Defaults to "HEAD~1" (committed changes).
   * - "HEAD~1" / any git rev — `git diff --name-only <rev>..HEAD`
   * - "staged"  — `git diff --cached --name-only`
   * - "working" — `git diff --name-only HEAD`
   */
  since?: ImpactSince;
}

export type ContractDiffKind = "additive" | "breaking" | "renaming" | "unknown";

export interface ContractDiff {
  file: string;
  kind: ContractDiffKind;
  details: string[];
}

export interface ImpactSuggestion {
  kind: "re_run" | "heal" | "regenerate" | "add_boundary_test";
  target: string;
  reasoning: string;
}

export interface ImpactV2Result {
  changed: {
    files: string[];
    routes: string[];
    contracts: string[];
  };
  affected: {
    specsToReRun: string[];
    specsLikelyBroken: Array<{ spec: string; reason: string }>;
    missingCoverage: Array<{ routeId: string; reason: string }>;
  };
  suggestions: ImpactSuggestion[];
  contractDiffs: ContractDiff[];
  graphVersion: string;
  /** Backward-compat v1 fields — callers that existed before B.3 still work. */
  changedFiles: string[];
  selectedRoutes: string[];
  warnings: string[];
}

export async function computeImpactV2(input: ImpactV2Input): Promise<ImpactV2Result> {
  const repoRoot = input.repoRoot;
  const since = input.since ?? "HEAD~1";
  const warnings: string[] = [];

  if (!repoRoot) throw new Error("repoRoot is required");

  const changedFiles = runGitDiff(repoRoot, since).map(toPosix);

  // Always compute v1 output for backward compat, but only when "since" is a
  // committed ref — "staged" / "working" don't make sense to v1's `base..head`
  // form.
  let v1: { changedFiles: string[]; selectedRoutes: string[]; warnings: string[] } = {
    changedFiles: [],
    selectedRoutes: [],
    warnings: [],
  };
  if (since !== "staged" && since !== "working") {
    try {
      v1 = await computeImpactV1({ repoRoot, base: since });
    } catch (err) {
      warnings.push(
        `v1 impact fallback failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  // Load the interaction graph + spec index.
  const graph = loadGraph(repoRoot);
  const graphVersion = graphVersionFromGraph(graph);

  if (!graph) {
    warnings.push("Interaction graph not found. Run mandu.ate.extract first.");
  }

  const specIndex = indexSpecs(repoRoot);

  const routeNodes = (graph?.nodes ?? []).filter(
    (n): n is Extract<InteractionNode, { kind: "route" }> => n.kind === "route",
  );

  // Route-file → routeId map.
  const routeFileToId = new Map<string, string>();
  for (const r of routeNodes) {
    const id = r.routeId ?? routeIdFromPath(r.path);
    routeFileToId.set(toPosix(resolve(repoRoot, r.file)), id);
  }

  // Classify each changed file.
  const routesSet = new Set<string>();
  const contractsSet = new Set<string>();
  const contractDiffs: ContractDiff[] = [];
  for (const f of changedFiles) {
    if (/\.contract\.tsx?$/.test(f)) {
      contractsSet.add(f);
      const diff = classifyContractDiff(repoRoot, f, since);
      contractDiffs.push(diff);
    }
    const abs = toPosix(resolve(repoRoot, f));
    const routeId = routeFileToId.get(abs);
    if (routeId) routesSet.add(routeId);
  }

  // Pull in v1's transitive impact.
  for (const id of v1.selectedRoutes) routesSet.add(id);

  // Specs to re-run: every indexed spec whose `covers` intersects our
  // affected route set.
  const specsToReRun: string[] = [];
  for (const spec of specIndex.specs) {
    if (spec.coverage.covers.some((id) => routesSet.has(id))) {
      specsToReRun.push(spec.path);
    }
  }

  // Specs likely broken: specs covering a route whose contract had a
  // breaking diff.
  const specsLikelyBroken: Array<{ spec: string; reason: string }> = [];
  const missingCoverage: Array<{ routeId: string; reason: string }> = [];
  const breakingContracts = new Set(
    contractDiffs.filter((d) => d.kind === "breaking").map((d) => d.file),
  );

  for (const d of contractDiffs) {
    if (d.kind !== "breaking" && d.kind !== "renaming") continue;
    // Find routes whose inferred-contract matches this file's base name.
    const relatedRouteIds = routesForContractFile(d.file, routeNodes);
    for (const routeId of relatedRouteIds) {
      const related = specIndex.specs.filter((s) => s.coverage.covers.includes(routeId));
      if (related.length === 0) {
        missingCoverage.push({
          routeId,
          reason: `contract ${d.file} is ${d.kind} and no spec covers ${routeId}`,
        });
      }
      for (const s of related) {
        specsLikelyBroken.push({
          spec: s.path,
          reason: `contract ${d.file} changed (${d.kind})`,
        });
      }
    }
  }

  // Suggestions.
  const suggestions: ImpactSuggestion[] = [];
  for (const spec of specsToReRun) {
    suggestions.push({
      kind: "re_run",
      target: spec,
      reasoning: "spec covers an affected route",
    });
  }
  for (const d of contractDiffs) {
    if (d.kind === "additive") {
      suggestions.push({
        kind: "add_boundary_test",
        target: d.file,
        reasoning: "contract gained field(s) — new boundary probe(s) likely needed",
      });
    } else if (d.kind === "breaking") {
      suggestions.push({
        kind: "regenerate",
        target: d.file,
        reasoning: "contract change is breaking — regenerate affected specs",
      });
    } else if (d.kind === "renaming") {
      suggestions.push({
        kind: "heal",
        target: d.file,
        reasoning: "contract renamed fields — heal existing specs to match",
      });
    }
  }
  if (breakingContracts.size > 0) {
    for (const { spec } of specsLikelyBroken) {
      suggestions.push({
        kind: "heal",
        target: spec,
        reasoning: "spec probably broken by contract breaking change",
      });
    }
  }

  return {
    changed: {
      files: changedFiles,
      routes: Array.from(routesSet),
      contracts: Array.from(contractsSet),
    },
    affected: {
      specsToReRun,
      specsLikelyBroken,
      missingCoverage,
    },
    suggestions: dedupSuggestions(suggestions),
    contractDiffs,
    graphVersion,
    // v1 backward compat
    changedFiles,
    selectedRoutes: Array.from(routesSet),
    warnings: [...warnings, ...v1.warnings],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// git helpers
// ──────────────────────────────────────────────────────────────────────────

function runGitDiff(repoRoot: string, since: ImpactSince): string[] {
  const args = resolveGitDiffArgs(since);
  try {
    // Prefer Bun.spawnSync when available.
    const anyBun = (globalThis as unknown as { Bun?: { spawnSync: Function } }).Bun;
    if (anyBun && typeof anyBun.spawnSync === "function") {
      const proc = anyBun.spawnSync(["git", ...args], { cwd: repoRoot });
      const out: Uint8Array | undefined = (proc as { stdout?: Uint8Array }).stdout;
      const decoder = new TextDecoder();
      const text = out ? decoder.decode(out) : "";
      return text.split("\n").map((l) => l.trim()).filter(Boolean);
    }
    // Fallback: child_process.
    const text = execFileSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
    return text.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function resolveGitDiffArgs(since: ImpactSince): string[] {
  if (since === "working") return ["diff", "--name-only", "HEAD"];
  if (since === "staged") return ["diff", "--cached", "--name-only"];
  // `HEAD~1` or any rev: diff that rev..HEAD.
  // Validate the rev lightly to prevent command injection — same rule as v1.
  if (!/^[0-9A-Za-z._/~^-]+$/.test(since)) {
    throw new Error(`Invalid git revision: ${since}`);
  }
  return ["diff", "--name-only", `${since}..HEAD`];
}

// ──────────────────────────────────────────────────────────────────────────
// contract diff classifier
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read the file's contents at `rev` (or null if the file didn't exist)
 * and compare to the working tree to classify the change. Uses `git show`.
 *
 * Classification rules:
 *   - All-new file → "additive" (no regression risk).
 *   - New required body field (present in new, absent in old) → "breaking".
 *   - Enum variant removed → "breaking".
 *   - Added optional body field → "additive".
 *   - Field renamed at same position (Levenshtein ≥ 0.8) → "renaming".
 *   - Everything else → "unknown".
 */
export function classifyContractDiff(
  repoRoot: string,
  relFile: string,
  since: ImpactSince,
): ContractDiff {
  const newSource = safeReadFile(resolve(repoRoot, relFile));
  let oldSource: string | null = null;
  if (since !== "working" && since !== "staged") {
    oldSource = gitShowFile(repoRoot, since, relFile);
  } else if (since === "working") {
    oldSource = gitShowFile(repoRoot, "HEAD", relFile);
  } else {
    oldSource = gitShowFile(repoRoot, "HEAD", relFile);
  }

  const details: string[] = [];

  if (oldSource === null && newSource !== null) {
    details.push("contract file added");
    return { file: relFile, kind: "additive", details };
  }
  if (oldSource !== null && newSource === null) {
    details.push("contract file deleted");
    return { file: relFile, kind: "breaking", details };
  }
  if (oldSource === null || newSource === null) {
    return { file: relFile, kind: "unknown", details: ["could not read contract content"] };
  }

  const oldFields = collectBodyFields(oldSource);
  const newFields = collectBodyFields(newSource);

  // Additions.
  const additions: Array<{ name: string; optional: boolean }> = [];
  for (const nf of newFields) {
    const o = oldFields.find((f) => f.name === nf.name);
    if (!o) additions.push(nf);
  }
  // Removals.
  const removals: typeof oldFields = [];
  for (const o of oldFields) {
    const n = newFields.find((f) => f.name === o.name);
    if (!n) removals.push(o);
  }

  // Detect renames: a removal and an addition at the same position with
  // high Levenshtein similarity are treated as renames.
  const renames: Array<{ from: string; to: string }> = [];
  for (const a of additions) {
    const sameIdx = newFields.findIndex((f) => f.name === a.name);
    const o = removals.find((r) => {
      const oldIdx = oldFields.findIndex((f) => f.name === r.name);
      return Math.abs(oldIdx - sameIdx) <= 1 && levenshteinRatio(r.name, a.name) >= 0.8;
    });
    if (o) renames.push({ from: o.name, to: a.name });
  }
  const renameFromSet = new Set(renames.map((r) => r.from));
  const renameToSet = new Set(renames.map((r) => r.to));

  const realAdditions = additions.filter((a) => !renameToSet.has(a.name));
  const realRemovals = removals.filter((r) => !renameFromSet.has(r.name));

  if (realRemovals.length > 0) {
    details.push(`removed fields: ${realRemovals.map((r) => r.name).join(", ")}`);
  }
  if (realAdditions.some((a) => !a.optional)) {
    details.push(
      `added required field(s): ${realAdditions
        .filter((a) => !a.optional)
        .map((a) => a.name)
        .join(", ")}`,
    );
  }
  if (realAdditions.some((a) => a.optional)) {
    details.push(
      `added optional field(s): ${realAdditions
        .filter((a) => a.optional)
        .map((a) => a.name)
        .join(", ")}`,
    );
  }
  if (renames.length > 0) {
    details.push(
      `renames: ${renames.map((r) => `${r.from}→${r.to}`).join(", ")}`,
    );
  }

  // Enum shrinkage (heuristic).
  if (detectEnumShrink(oldSource, newSource)) {
    details.push("enum variant(s) removed");
  }

  // Classification precedence:
  //   removed required OR enum shrink OR required-added OR explicit deletion
  //   → breaking
  //   renaming (no breaking) → renaming
  //   only additive-optional → additive
  //   else unknown.
  if (
    realRemovals.length > 0 ||
    realAdditions.some((a) => !a.optional) ||
    detectEnumShrink(oldSource, newSource)
  ) {
    return { file: relFile, kind: "breaking", details };
  }
  if (renames.length > 0) {
    return { file: relFile, kind: "renaming", details };
  }
  if (realAdditions.some((a) => a.optional)) {
    return { file: relFile, kind: "additive", details };
  }
  return { file: relFile, kind: "unknown", details };
}

interface BodyField {
  name: string;
  optional: boolean;
}

function collectBodyFields(source: string): BodyField[] {
  // Walk every `<METHOD>: { body: z.object({...}) }` in the contract.
  const out: BodyField[] = [];
  const methodRe = /\b(GET|POST|PUT|PATCH|DELETE)\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(source)) !== null) {
    const openIdx = source.indexOf("{", m.index + m[0].length - 1);
    const mBlock = extractBalanced(source, openIdx, "{", "}");
    if (!mBlock) continue;
    const bodyIdx = mBlock.search(/\bbody\s*:\s*z\s*\.\s*object\s*\(\s*\{/);
    if (bodyIdx === -1) continue;
    const bodyOpen = mBlock.indexOf("{", bodyIdx + "body:".length);
    const inner = extractBalanced(mBlock, bodyOpen, "{", "}");
    if (!inner) continue;
    for (const f of splitObjectFields(inner)) {
      const optional = /\.optional\s*\(/.test(f.expr) || /\.nullish\s*\(/.test(f.expr);
      out.push({ name: f.name, optional });
    }
  }
  return out;
}

function detectEnumShrink(oldSrc: string, newSrc: string): boolean {
  const oldEnums = collectEnumVariants(oldSrc);
  const newEnums = collectEnumVariants(newSrc);
  // For any matching enum, if new has fewer variants than old, call it shrink.
  for (const [name, oldVals] of oldEnums) {
    const newVals = newEnums.get(name);
    if (!newVals) continue;
    if (newVals.size < oldVals.size) return true;
    for (const v of oldVals) if (!newVals.has(v)) return true;
  }
  return false;
}

/** Very loose: `const FooSchema = z.enum([...])` name → variants. */
function collectEnumVariants(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*z\.enum\s*\(\s*\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const vals = new Set<string>();
    const strs = m[2].match(/['"`]([^'"`]+)['"`]/g) ?? [];
    for (const s of strs) vals.add(s.replace(/['"`]/g, ""));
    out.set(m[1], vals);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// helpers shared with boundary/index.ts
// ──────────────────────────────────────────────────────────────────────────

function extractBalanced(src: string, start: number, open: string, close: string): string | null {
  if (src[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

interface ObjectField {
  name: string;
  expr: string;
}

function splitObjectFields(inner: string): ObjectField[] {
  const out: ObjectField[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i++;
    if (i >= inner.length) break;
    const rest = inner.slice(i);
    const keyMatch =
      rest.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/) ||
      rest.match(/^['"]([^'"]+)['"]\s*:/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const name = keyMatch[1];
    i += keyMatch[0].length;
    let depth = 0;
    const start = i;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) break;
      i++;
    }
    out.push({ name, expr: inner.slice(start, i).trim() });
  }
  return out;
}

/**
 * Normalized Levenshtein ratio in [0, 1]. 1 = identical, 0 = totally
 * disjoint.
 */
export function levenshteinRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const d = levenshteinDistance(a, b);
  return 1 - d / maxLen;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function loadGraph(repoRoot: string): InteractionGraph | null {
  const paths = getAtePaths(repoRoot);
  if (!fileExists(paths.interactionGraphPath)) return null;
  try {
    return JSON.parse(readFileSync(paths.interactionGraphPath, "utf8")) as InteractionGraph;
  } catch {
    return null;
  }
}

function routesForContractFile(
  contractFile: string,
  routeNodes: Array<Extract<InteractionNode, { kind: "route" }>>,
): string[] {
  // Map e.g. "demo/todo-app/spec/contracts/api-todos.contract.ts"
  //   → route pattern "/api/todos".
  const base = contractFile.replace(/\\/g, "/").split("/").pop() ?? "";
  const name = base.replace(/\.contract\.(ts|tsx)$/, "");
  const parts = name.split("-").map((p) => (p.startsWith("$") ? `:${p.slice(1)}` : p));
  const routePattern = "/" + parts.join("/");

  const out: string[] = [];
  for (const r of routeNodes) {
    if (r.path === routePattern) out.push(r.routeId ?? routeIdFromPath(r.path));
  }
  return out;
}

function safeReadFile(abs: string): string | null {
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function gitShowFile(repoRoot: string, rev: string, relFile: string): string | null {
  try {
    const anyBun = (globalThis as unknown as { Bun?: { spawnSync: Function } }).Bun;
    const normalized = relFile.replace(/\\/g, "/");
    const args = ["show", `${rev}:${normalized}`];
    if (anyBun && typeof anyBun.spawnSync === "function") {
      const proc = anyBun.spawnSync(["git", ...args], { cwd: repoRoot });
      const exit = (proc as { exitCode?: number; exitCode_?: number }).exitCode;
      if (typeof exit === "number" && exit !== 0) return null;
      const out = (proc as { stdout?: Uint8Array }).stdout;
      if (!out) return null;
      return new TextDecoder().decode(out);
    }
    return execFileSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  } catch {
    return null;
  }
}

function dedupSuggestions(list: ImpactSuggestion[]): ImpactSuggestion[] {
  const seen = new Set<string>();
  const out: ImpactSuggestion[] = [];
  for (const s of list) {
    const key = `${s.kind}|${s.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

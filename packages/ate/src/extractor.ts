import fg from "fast-glob";
import { readFileSync, existsSync } from "node:fs";
import { relative, join, dirname, basename } from "node:path";
import { createEmptyGraph, addEdge, addNode } from "./ir";
import { getAtePaths, writeJson } from "./fs";
import type { ExtractInput, InteractionGraph } from "./types";
import type { Node, CallExpression, JsxAttribute, SyntaxKindEnum } from "./ts-morph-types";
import {
  routeIdFromPath,
  extractStaticParamsFromSource,
  scanMiddlewareIdentifiers,
  scanFillingActionNames,
  scanFillingMethods,
  isFillingSource,
  isLikelyModalName,
} from "./extractor-utils";

const DEFAULT_ROUTE_GLOBS = [
  "app/**/page.tsx",
  "app/**/route.ts",
  "routes/**/page.tsx",
  "routes/**/route.ts",
];

/**
 * Companion-file globs — scanned relative to each route directory.
 * Slot files register typed data loaders; island/client files mark
 * client-hydrated components; action files expose server-side actions
 * invokable via the `_action` protocol.
 */
const SLOT_EXTENSIONS = [".slot.ts", ".slot.tsx"];
const ISLAND_EXTENSIONS = [".client.tsx", ".client.ts", ".island.tsx", ".island.ts"];
const ACTION_EXTENSIONS = [".action.ts", ".action.tsx"];

function isStringLiteral(node: Node, SK: SyntaxKindEnum): boolean {
  return node.getKind() === SK.StringLiteral;
}

function tryExtractLiteralArg(callExpr: CallExpression, argIndex = 0, SK: SyntaxKindEnum): string | null {
  const args = callExpr.getArguments();
  const arg = args[argIndex];
  if (!arg) return null;
  if (isStringLiteral(arg, SK)) return (arg as Node & { getLiteralValue(): string }).getLiteralValue();
  return null;
}

export async function extract(input: ExtractInput): Promise<{ ok: true; graphPath: string; summary: { nodes: number; edges: number }; warnings: string[] }> {
  const repoRoot = input.repoRoot;
  const buildSalt = input.buildSalt ?? process.env.MANDU_BUILD_SALT ?? "dev";
  const paths = getAtePaths(repoRoot);
  const warnings: string[] = [];

  const graph: InteractionGraph = createEmptyGraph(buildSalt);

  // Validate input
  if (!repoRoot) {
    throw new Error("repoRoot는 필수입니다");
  }

  const routeGlobs = input.routeGlobs?.length ? input.routeGlobs : DEFAULT_ROUTE_GLOBS;

  let routeFiles: string[];
  try {
    routeFiles = await fg(routeGlobs, {
      cwd: repoRoot,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.mandu/**"],
    });
  } catch (err: unknown) {
    throw new Error(`파일 검색 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if (routeFiles.length === 0) {
    warnings.push(`경고: route 파일을 찾을 수 없습니다 (globs: ${routeGlobs.join(", ")})`);
  }

  // Lazy load ts-morph only when needed
  const { Project, SyntaxKind } = await import("ts-morph");
  const SK = SyntaxKind as unknown as SyntaxKindEnum;

  let project: InstanceType<typeof Project>;
  try {
    project = new Project({
      tsConfigFilePath: input.tsconfigPath ? join(repoRoot, input.tsconfigPath) : undefined,
      skipAddingFilesFromTsConfig: true,
    });
  } catch (err: unknown) {
    throw new Error(`TypeScript 프로젝트 초기화 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  for (const filePath of routeFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      const rel = relative(repoRoot, filePath);
      const relNormalized = rel.replace(/\\/g, "/");

      const isApiRoute = relNormalized.endsWith("/route.ts");

      // route node id: normalize to path without trailing /page.tsx or /route.ts
      const routePath = relNormalized
        .replace(/^app\//, "/")
        .replace(/^routes\//, "/")
        .replace(/\/page\.tsx$/, "")
        .replace(/\/route\.ts$/, "")
        .replace(/\/index\.tsx$/, "")
        .replace(/\/page$/, "")
        .replace(/\\/g, "/");

      const resolvedPath = routePath === "" ? "/" : routePath;
      const routeId = routeIdFromPath(resolvedPath);

      const sourceText = sourceFile.getFullText();

      // API route: extract HTTP methods from exports (GET, POST, PUT, PATCH, DELETE)
      let methods: string[] = [];
      let hasSse = false;
      let hasAction = false;
      if (isApiRoute) {
        const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
        const exportDecls = sourceFile.getExportedDeclarations();
        for (const [name] of exportDecls) {
          if (HTTP_METHODS.includes(name)) {
            methods.push(name);
          }
        }

        // Filling-style chains (`.post(...)`, `.get(...)`) are also valid
        // for API routes — the `default` export is a Filling. Probe the
        // source text so we don't miss these.
        const chainMethods = scanFillingMethods(sourceText);
        for (const m of chainMethods) {
          if (!methods.includes(m)) methods.push(m);
        }

        if (methods.length === 0) methods = ["GET"]; // default

        // Detect SSE and _action patterns from source text
        hasSse = /ctx\.sse|text\/event-stream|EventSource|new\s+ReadableStream/.test(sourceText);
        hasAction = methods.includes("POST") && /_action/.test(sourceText);
      }

      // Page route: detect meta-refresh redirect or server redirect() return.
      // A route that emits <meta http-equiv="refresh" ...> or returns a Response
      // produced by redirect() performs a page-level navigation on load, which
      // breaks downstream Playwright assertions that call page.content() before
      // the navigation settles (issue #224).
      let isRedirect = false;
      if (!isApiRoute) {
        // JSX: <meta httpEquiv="refresh" ...> or <meta http-equiv="refresh" ...>
        const metaRefresh = /<meta\s+[^>]*http-?[Ee]quiv\s*=\s*["'{][^"'}]*refresh/i.test(sourceText)
          || /httpEquiv\s*=\s*["'{]\s*refresh/i.test(sourceText);
        // Server-side: `return redirect(...)` (mandu runtime helper) at top level
        const serverRedirect = /\breturn\s+redirect\s*\(/.test(sourceText);
        isRedirect = metaRefresh || serverRedirect;
      }

      // Detect companion island and contract files
      const routeDir = dirname(filePath);
      const hasIsland = [".island.tsx", ".island.ts", ".client.tsx", ".client.ts"]
        .some(ext => fg.sync(`*${ext}`, { cwd: routeDir, onlyFiles: true }).length > 0);
      const hasContract = [".contract.ts", ".contract.tsx"]
        .some(ext => fg.sync(`*${ext}`, { cwd: routeDir, onlyFiles: true }).length > 0);

      // Phase A.1: statically extract generateStaticParams sample set for
      // dynamic routes. The exact set fuels Phase B's boundary probe —
      // surfacing it here avoids a second AST walk.
      const staticParams = /\[.+?\]/.test(resolvedPath)
        ? extractStaticParamsFromSource(sourceText) ?? undefined
        : undefined;

      addNode(graph, {
        kind: "route",
        id: resolvedPath,
        file: relNormalized,
        path: resolvedPath,
        routeId,
        ...(isApiRoute ? { methods } : {}),
        ...(hasIsland ? { hasIsland: true } : {}),
        ...(hasContract ? { hasContract: true } : {}),
        ...(hasSse ? { hasSse: true } : {}),
        ...(hasAction ? { hasAction: true } : {}),
        ...(isRedirect ? { isRedirect: true } : {}),
        ...(staticParams && staticParams.length > 0 ? { staticParams } : {}),
      });

      // Phase A.1: Filling node — every route file that looks like a
      // Filling handler (chained `.use()`/`.get()`/`.post()` etc.) gets
      // an explicit filling node with middleware + action inventory.
      // The route node still owns the URL metadata; the filling node
      // owns the handler surface.
      if (isFillingSource(sourceText)) {
        const middlewareNames = scanMiddlewareIdentifiers(sourceText);
        const fillingActions = scanFillingActionNames(sourceText);
        const fillingMethods = isApiRoute ? methods : scanFillingMethods(sourceText);

        addNode(graph, {
          kind: "filling",
          id: `filling:${routeId}`,
          file: relNormalized,
          routeId,
          methods: fillingMethods,
          middlewareNames,
          actions: fillingActions,
        });

        // Emit a named action node for each `.action(...)` entry so
        // downstream tooling (impact graph, coverage gap detector)
        // can treat actions as first-class callable surfaces.
        for (const actionName of fillingActions) {
          addNode(graph, {
            kind: "action",
            id: `action:${routeId}:${actionName}`,
            file: relNormalized,
            name: actionName,
            routeId,
          });
        }
      }

      // Phase A.1: companion files — scan the sibling directory once
      // per route and emit slot / island / action nodes for every
      // matching file. We deliberately use sync fg here (same as the
      // existing island/contract probe) — the directory is small.
      scanCompanionFiles({
        graph,
        routeDir,
        repoRoot,
        routeId,
        warnings,
      });

      // API route에는 JSX/navigation이 없으므로 건너뜀
      if (isApiRoute) continue;

      // ManduLink / Link literal extraction: <Link href="/x"> or <ManduLink to="/x">
      // Also: <form action="...">, <Form action="...">, modal components.
      //
      // AST shape note: a `JsxAttribute`'s direct parent is `JsxAttributes`
      // (the attribute *list*), and the grandparent is the owning
      // `JsxOpeningElement` / `JsxSelfClosingElement`. We walk two steps
      // up to name the element and group attributes by element start
      // position so multi-attribute forms emit a single `form` node.
      try {
        const jsxAttrs = sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute) as unknown as JsxAttribute[];
        const formAction = new Map<number, { action?: string; method?: string; id: string }>();

        for (const attr of jsxAttrs) {
          try {
            const name = attr.getNameNode?.().getText?.() ?? attr.getName?.() ?? "";

            // Walk up: JsxAttribute → JsxAttributes → JsxOpeningElement/JsxSelfClosingElement
            const attrsParent = (attr as unknown as { getParent?: () => Node | undefined })
              .getParent?.();
            const owningElement = (attrsParent as unknown as { getParent?: () => Node | undefined } | undefined)
              ?.getParent?.();
            const owningTagNode = (owningElement as unknown as { getTagNameNode?: () => { getText(): string } } | undefined)
              ?.getTagNameNode?.();
            const owningTag = owningTagNode?.getText?.() ?? "";
            const isFormElement = owningTag === "form" || owningTag === "Form";
            const isLinkTo = name === "to" || name === "href";

            if (!isLinkTo && !isFormElement) continue;

            const init = attr.getInitializer?.();
            if (!init) continue;
            if (init.getKind?.() !== SK.StringLiteral) continue;

            const raw = init.getLiteralValue?.() ?? init.getText?.();
            const value = typeof raw === "string" ? raw.replace(/^"|"$/g, "") : null;
            if (typeof value !== "string") continue;

            if (isLinkTo && value.startsWith("/")) {
              addEdge(graph, {
                kind: "navigate",
                from: routePath || "/",
                to: value,
                file: relNormalized,
                source: `<jsx ${name}>`,
              });
              continue;
            }

            if (isFormElement) {
              // Key by the owning element's source position so two
              // attributes on the same `<form>` land in the same
              // bucket. Fallback to -1 if somehow missing.
              const elementKey = (owningElement as unknown as { getPos?: () => number } | undefined)
                ?.getPos?.() ?? -1;
              const existing = formAction.get(elementKey) ?? {
                id: `form:${routeId}:${formAction.size}`,
              };
              if (name === "action") existing.action = value;
              if (name === "method") existing.method = value.toUpperCase();
              formAction.set(elementKey, existing);

              // If this element also houses an explicit action target
              // pointing at an API route, record a navigate-style edge
              // so impact analysis links page ↔ API surface.
              if (name === "action" && value.startsWith("/")) {
                addEdge(graph, {
                  kind: "navigate",
                  from: routePath || "/",
                  to: value,
                  file: relNormalized,
                  source: "<form action>",
                });
              }
            }
          } catch (err: unknown) {
            // Skip invalid JSX attributes
            warnings.push(`JSX 속성 파싱 실패 (${relNormalized}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Flush collected form elements as nodes.
        for (const form of formAction.values()) {
          addNode(graph, {
            kind: "form",
            id: form.id,
            file: relNormalized,
            routeId,
            ...(form.action ? { action: form.action } : {}),
            ...(form.method ? { method: form.method } : {}),
          });
        }
      } catch (err: unknown) {
        warnings.push(`JSX 분석 실패 (${relNormalized}): ${err instanceof Error ? err.message : String(err)}`);
      }

      // mandu.navigate("/x") literal + mandu.modal.open + mandu.action.run +
      // useRouter().push(...) literal.
      try {
        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression) as unknown as CallExpression[];
        for (const call of calls) {
          try {
            const exprText = call.getExpression().getText();
            if (exprText === "mandu.navigate" || exprText.endsWith(".navigate")) {
              const to = tryExtractLiteralArg(call, 0, SK);
              if (to && to.startsWith("/")) {
                addEdge(graph, { kind: "navigate", from: routePath || "/", to, file: relNormalized, source: "mandu.navigate" });
              }
            }
            if (exprText.endsWith(".push") || /\brouter\.push$/.test(exprText)) {
              const to = tryExtractLiteralArg(call, 0, SK);
              if (to && to.startsWith("/")) {
                addEdge(graph, {
                  kind: "navigate",
                  from: routePath || "/",
                  to,
                  file: relNormalized,
                  source: "router.push",
                });
              }
            }
            if (exprText === "mandu.modal.open" || exprText.endsWith(".modal.open")) {
              const modal = tryExtractLiteralArg(call, 0, SK);
              if (modal) {
                addEdge(graph, { kind: "openModal", from: routePath || "/", modal, file: relNormalized, source: "mandu.modal.open" });
                // Also emit a modal node so `kind === "modal"` consumers
                // pick up declarative modal names.
                addNode(graph, {
                  kind: "modal",
                  id: `modal:${routeId}:${modal}`,
                  file: relNormalized,
                  name: modal,
                  routeId,
                });
              }
            }
            if (exprText === "mandu.action.run" || exprText.endsWith(".action.run")) {
              const action = tryExtractLiteralArg(call, 0, SK);
              if (action) {
                addEdge(graph, { kind: "runAction", from: routePath || "/", action, file: relNormalized, source: "mandu.action.run" });
              }
            }
          } catch (err: unknown) {
            // Skip invalid call expressions
            warnings.push(`함수 호출 파싱 실패 (${relNormalized}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err: unknown) {
        warnings.push(`함수 호출 분석 실패 (${relNormalized}): ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err: unknown) {
      // Graceful degradation: skip this file and continue
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`파일 파싱 실패 (${filePath}): ${msg}`);
      console.warn(`[ATE] 파일 스킵: ${filePath} - ${msg}`);
      continue;
    }
  }

  try {
    writeJson(paths.interactionGraphPath, graph);
  } catch (err: unknown) {
    throw new Error(`Interaction graph 저장 실패: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  return {
    ok: true,
    graphPath: paths.interactionGraphPath,
    summary: { nodes: graph.nodes.length, edges: graph.edges.length },
    warnings,
  };
}

/**
 * Scan the directory containing a route file for the three classes of
 * companion modules Phase A.1 exposes as first-class nodes:
 *
 *   *.slot.ts(x)    → slot node
 *   *.client.ts(x)  → island node
 *   *.island.ts(x)  → island node
 *   *.action.ts(x)  → action node
 *
 * Each node records the repo-relative path, the derived name (file
 * basename without extension), and the owning routeId so the context
 * builder can compose a per-route view.
 *
 * Modal detection: any companion file whose basename contains "modal"
 * also gets a modal node — see `isLikelyModalName`. This is the
 * "convention" side of the roadmap's #228 callout.
 */
function scanCompanionFiles(input: {
  graph: InteractionGraph;
  routeDir: string;
  repoRoot: string;
  routeId: string;
  warnings: string[];
}): void {
  const { graph, routeDir, repoRoot, routeId, warnings } = input;

  const collect = (patterns: string[]): string[] => {
    try {
      return fg.sync(
        patterns.map((p) => `*${p}`),
        { cwd: routeDir, onlyFiles: true, absolute: true },
      );
    } catch (err: unknown) {
      warnings.push(
        `companion 파일 스캔 실패 (${routeDir}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  };

  const slotFiles = collect(SLOT_EXTENSIONS);
  for (const abs of slotFiles) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const name = basename(abs).replace(/\.slot\.tsx?$/, "");
    addNode(graph, {
      kind: "slot",
      id: `slot:${routeId}:${name}`,
      file: rel,
      name,
      routeId,
    });
    if (isLikelyModalName(name)) {
      addNode(graph, {
        kind: "modal",
        id: `modal:${routeId}:${name}`,
        file: rel,
        name,
        routeId,
      });
    }
  }

  const islandFiles = collect(ISLAND_EXTENSIONS);
  for (const abs of islandFiles) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const name = basename(abs).replace(/\.(client|island)\.tsx?$/, "");
    addNode(graph, {
      kind: "island",
      id: `island:${routeId}:${name}`,
      file: rel,
      name,
      routeId,
    });
    if (isLikelyModalName(name)) {
      addNode(graph, {
        kind: "modal",
        id: `modal:${routeId}:${name}`,
        file: rel,
        name,
        routeId,
      });
    }
  }

  const actionFiles = collect(ACTION_EXTENSIONS);
  for (const abs of actionFiles) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const name = basename(abs).replace(/\.action\.tsx?$/, "");
    addNode(graph, {
      kind: "action",
      id: `action:${routeId}:${name}`,
      file: rel,
      name,
      routeId,
    });
  }
}

/**
 * Probe for repo-global slot / island / action files that live
 * outside a route directory (e.g. `spec/slots/*.slot.ts`). Called by
 * the MCP context builder when assembling a project-scope view so
 * we don't miss shared primitives. Kept separate from `extract()`
 * because the interaction graph is route-centric by design.
 */
export function scanRepoWideCompanions(repoRoot: string): {
  slots: Array<{ file: string; name: string }>;
  islands: Array<{ file: string; name: string }>;
  actions: Array<{ file: string; name: string }>;
} {
  const patterns = {
    slots: ["**/*.slot.ts", "**/*.slot.tsx"],
    islands: ["**/*.client.ts", "**/*.client.tsx", "**/*.island.ts", "**/*.island.tsx"],
    actions: ["**/*.action.ts", "**/*.action.tsx"],
  };
  const ignore = ["**/node_modules/**", "**/.mandu/**", "**/dist/**"];
  const result = {
    slots: [] as Array<{ file: string; name: string }>,
    islands: [] as Array<{ file: string; name: string }>,
    actions: [] as Array<{ file: string; name: string }>,
  };
  try {
    for (const abs of fg.sync(patterns.slots, { cwd: repoRoot, absolute: true, ignore })) {
      const rel = relative(repoRoot, abs).replace(/\\/g, "/");
      const name = basename(abs).replace(/\.slot\.tsx?$/, "");
      result.slots.push({ file: rel, name });
    }
    for (const abs of fg.sync(patterns.islands, { cwd: repoRoot, absolute: true, ignore })) {
      const rel = relative(repoRoot, abs).replace(/\\/g, "/");
      const name = basename(abs).replace(/\.(client|island)\.tsx?$/, "");
      result.islands.push({ file: rel, name });
    }
    for (const abs of fg.sync(patterns.actions, { cwd: repoRoot, absolute: true, ignore })) {
      const rel = relative(repoRoot, abs).replace(/\\/g, "/");
      const name = basename(abs).replace(/\.action\.tsx?$/, "");
      result.actions.push({ file: rel, name });
    }
  } catch {
    // Repo probe is best-effort — callers see partial results.
  }
  return result;
}

/**
 * Read a contract file and extract its `examples` blocks. We use a
 * source-level scan (no eval) because the contract module imports
 * `@mandujs/core` which may not be resolvable from the ATE worker
 * process.
 *
 * Examples live at `request.<METHOD>.examples` and `response.<STATUS>.examples`.
 * Each example is an arbitrary JS literal — we capture the source
 * text as-is so agents can paste it into generated specs.
 *
 * Returns a flat list so context callers can filter by method / status.
 */
export function readContractExamples(filePath: string): Array<{
  kind: "request" | "response";
  method?: string;
  status?: number;
  name: string;
  /** Raw JS literal text (object literal or value). */
  literal: string;
}> {
  if (!existsSync(filePath)) return [];
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const results: Array<{
    kind: "request" | "response";
    method?: string;
    status?: number;
    name: string;
    literal: string;
  }> = [];

  // Pattern: `examples: { valid: {...}, duplicate_email: {...} }` nested
  // inside either a `request` or `response` method/status block. We
  // do a two-pass scan — first locate the enclosing method/status
  // header, then find the `examples:` block, then parse its entries.
  const examplesRegex = /\bexamples\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = examplesRegex.exec(source)) !== null) {
    const start = source.indexOf("{", m.index);
    if (start === -1) continue;
    const block = extractBalanced(source, start, "{", "}");
    if (!block) continue;

    // Determine the enclosing context. The `examples:` block lives
    // inside either a `request.<METHOD>: { ... }` or
    // `response.<STATUS>: { ... }` block. We locate the enclosing
    // label by walking backwards from the examples position, skipping
    // over balanced `{...}` siblings (e.g. `body: z.object({...})`
    // comes before the `examples:` key in the same method block).
    const { method, status, kind } = findEnclosingContractScope(source, m.index);

    // Parse the examples object — each entry is `name: <literal>`.
    const entries = parseExamplesBlock(block);
    for (const entry of entries) {
      results.push({
        kind,
        ...(method ? { method } : {}),
        ...(status !== undefined ? { status } : {}),
        name: entry.name,
        literal: entry.literal,
      });
    }
  }

  return results;
}

/**
 * Walk backwards from `examplesStart` inside a contract source string
 * to find the enclosing `request.<METHOD>` or `response.<STATUS>`
 * block. We scan character-by-character, tracking brace depth in
 * reverse — when depth drops below 0 we've left the current block.
 * That left-edge position is then probed for a method / status label
 * that opens the block we just exited.
 */
function findEnclosingContractScope(
  source: string,
  examplesStart: number,
): { method?: string; status?: number; kind: "request" | "response" } {
  let depth = 0;
  let i = examplesStart - 1;
  while (i >= 0) {
    const ch = source[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        // Found the opening brace of the enclosing block. Look back
        // for `<label>:` immediately before it.
        const before = source.slice(Math.max(0, i - 40), i);
        const methodMatch = before.match(/(GET|POST|PUT|PATCH|DELETE)\s*:\s*$/);
        const statusMatch = before.match(/(\d{3})\s*:\s*$/);
        if (methodMatch) {
          // Also determine request vs response by looking further back.
          const prefix = source.slice(0, i);
          const kind = kindForPrefix(prefix);
          return { method: methodMatch[1], kind };
        }
        if (statusMatch) {
          const prefix = source.slice(0, i);
          const kind = kindForPrefix(prefix);
          return { status: Number(statusMatch[1]), kind };
        }
        // No label directly before brace — keep walking outward.
        depth--; // step out of this block
      } else {
        depth--;
      }
    }
    i--;
  }
  // Fallback — classify kind only.
  return { kind: kindForPrefix(source.slice(0, examplesStart)) };
}

function kindForPrefix(prefix: string): "request" | "response" {
  const responseIdx = prefix.lastIndexOf("response");
  const requestIdx = prefix.lastIndexOf("request");
  return responseIdx > requestIdx ? "response" : "request";
}

function extractBalanced(src: string, start: number, open: string, close: string): string | null {
  if (src[start] !== open) return null;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
    i++;
  }
  return null;
}

function parseExamplesBlock(body: string): Array<{ name: string; literal: string }> {
  const out: Array<{ name: string; literal: string }> = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;

    // key
    const rest = body.slice(i);
    const keyMatch =
      rest.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/) ||
      rest.match(/^['"]([^'"]+)['"]\s*:/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const name = keyMatch[1];
    i += keyMatch[0].length;

    // value — skip whitespace then capture until the next top-level comma
    while (i < body.length && /\s/.test(body[i])) i++;
    let depth = 0;
    const start = i;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        i++;
        while (i < body.length && body[i] !== quote) {
          if (body[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      i++;
    }
    out.push({ name, literal: body.slice(start, i).trim() });
  }
  return out;
}

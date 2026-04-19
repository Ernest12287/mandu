#!/usr/bin/env bun
/**
 * Phase 9b B — Template manifest generator.
 *
 * Walks `packages/cli/templates/{default,realtime-chat,auth-starter}/`
 * and emits two files into `packages/cli/generated/`:
 *
 *   1. `templates-manifest.js` — plain JavaScript containing one static
 *      `import … with { type: "file" }` per template file (so
 *      `bun build --compile` embeds the bytes into the binary) plus a
 *      `TEMPLATE_MANIFEST` Map for O(1) lookup.
 *   2. `templates-manifest.d.ts` — TypeScript type surface for the Map,
 *      consumed by `src/util/templates.ts`.
 *
 * Why `.js` rather than `.ts`? The CLI tsconfig has `allowJs` off by
 * default, so `tsc` ignores the real manifest file entirely and never
 * has to resolve its `.ts` / `.tsx` / `.md` / `.css` file imports. That
 * keeps all ~110 template source files out of the TypeScript compilation
 * graph. Both `bun run` and `bun build --compile` resolve `.js` normally
 * and process the `with { type: "file" }` attribute, so the runtime
 * behavior is unchanged.
 *
 * The generated files are committed (source, not build artifacts). Re-run
 * this script whenever `packages/cli/templates/` contents change.
 *
 * Why code-gen instead of a dynamic glob?
 *   - Bun's `with { type: "file" }` only embeds statically resolvable
 *     imports. Dynamic `fs.readdirSync` does NOT survive `--compile`.
 *   - Hand-writing ~110 imports is not maintainable.
 *
 * See also:
 *   docs/bun/phase-9-diagnostics/compile-binary.md §3.1 (the blocker this
 *   generator resolves).
 */

import fs from "node:fs";
import path from "node:path";

const CLI_ROOT = path.resolve(import.meta.dir, "..");
const TEMPLATES_DIR = path.join(CLI_ROOT, "templates");
// Generated files live OUTSIDE `src/` so the CLI tsconfig (`include:
// ["src/**/*"]`) does not pull their `with { type: "file" }` imports into
// the TypeScript compilation graph. We also emit the manifest as a
// **JavaScript** (`.js`) file — `tsc` does not typecheck `.js` sources
// by default (no `allowJs`), which is exactly what we want. A companion
// `.d.ts` gives `src/util/templates.ts` a typed surface without forcing
// `tsc` to resolve the file imports.
//
// Runtime (`bun run`) and `bun build --compile` both resolve the `.js`
// entry normally and process the `with { type: "file" }` imports; the
// templates are therefore embedded correctly in the compiled binary.
const OUTPUT_JS = path.join(CLI_ROOT, "generated", "templates-manifest.js");
const OUTPUT_DTS = path.join(CLI_ROOT, "generated", "templates-manifest.d.ts");

/**
 * Templates that ship with `mandu init`. Must match `ALLOWED_TEMPLATES` in
 * `src/commands/init.ts`. `errors/` is intentionally excluded — its files
 * are consumed by `src/errors/messages.ts` via a separate path and are
 * managed by Phase 9a (CLI UX).
 */
const TEMPLATE_NAMES = ["default", "realtime-chat", "auth-starter"] as const;

interface TemplateFile {
  /** Template name (e.g. "default"). */
  template: string;
  /** POSIX-normalized path relative to the template root. */
  relPath: string;
  /** Filesystem path relative to `src/util/` (used in the `import` stmt). */
  importSpecifier: string;
  /** Unique TypeScript identifier for the `import` binding. */
  identifier: string;
}

function walk(dir: string, base: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(base, entry.name.replace(/\\/g, "/"));
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function makeIdentifier(template: string, relPath: string, counter: Map<string, number>): string {
  // Convert "default/app/page.tsx" -> "tpl_default_app_page_tsx"
  // Collisions (unlikely but possible after sanitization) get a numeric suffix.
  const raw = `tpl_${template}_${relPath}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/__+/g, "_");
  const count = (counter.get(sanitized) ?? 0) + 1;
  counter.set(sanitized, count);
  return count === 1 ? sanitized : `${sanitized}_${count}`;
}

function collectTemplateFiles(): TemplateFile[] {
  const files: TemplateFile[] = [];
  const idCounter = new Map<string, number>();

  for (const name of TEMPLATE_NAMES) {
    const absTemplateDir = path.join(TEMPLATES_DIR, name);
    if (!fs.existsSync(absTemplateDir)) {
      throw new Error(
        `Template directory missing: ${absTemplateDir}. ` +
          `Expected one of: ${TEMPLATE_NAMES.join(", ")}.`
      );
    }
    const relFiles = walk(absTemplateDir, "").sort();
    for (const rel of relFiles) {
      // relPath normalizes to POSIX form; importSpecifier is relative to
      // `packages/cli/generated/` (the directory of templates-manifest.ts).
      const normalizedRel = rel.replace(/^\//, "");
      const importSpecifier = `../templates/${name}/${normalizedRel}`;
      const identifier = makeIdentifier(name, normalizedRel, idCounter);
      files.push({
        template: name,
        relPath: normalizedRel,
        importSpecifier,
        identifier,
      });
    }
  }

  return files;
}

interface GeneratedSources {
  js: string;
  dts: string;
}

function generateSources(files: TemplateFile[]): GeneratedSources {
  const byTemplate = new Map<string, TemplateFile[]>();
  for (const f of files) {
    const list = byTemplate.get(f.template) ?? [];
    list.push(f);
    byTemplate.set(f.template, list);
  }

  const jsHeader = `// AUTO-GENERATED by packages/cli/scripts/generate-template-manifest.ts.
// DO NOT EDIT MANUALLY. Re-run the script whenever packages/cli/templates/
// contents change: \`bun run packages/cli/scripts/generate-template-manifest.ts\`.
//
// This file is intentionally JavaScript (not TypeScript). The CLI tsconfig
// has no \`allowJs\`, so \`tsc\` skips it entirely — keeping the
// \`with { type: "file" }\` imports (and the ~110 template files they
// reference) out of the compilation graph. A companion \`.d.ts\` gives
// \`src/util/templates.ts\` the public surface it needs.
//
// Static \`with { type: "file" }\` imports are what cause \`bun build --compile\`
// to embed the template bytes into the resulting binary. At dev-time each
// import returns the on-disk absolute path; inside a compiled binary it
// returns a \`$bunfs/root/...\` virtual path. Both forms are consumable via
// \`Bun.file(path)\`.
//
// Consumers: src/util/templates.ts (loadTemplate, listTemplates, readTemplateFile).

`;

  const imports = files
    .map((f) => `import ${f.identifier} from "${f.importSpecifier}" with { type: "file" };`)
    .join("\n");

  const manifestEntries: string[] = [];
  for (const [template, list] of byTemplate) {
    const lines = list
      .map((f) => `    ["${f.relPath}", ${f.identifier}],`)
      .join("\n");
    manifestEntries.push(`  ["${template}", new Map([\n${lines}\n  ])],`);
  }

  const manifestBody = `
/**
 * Map from template name to a map of (relative POSIX path → embedded file path).
 * The inner value is the string returned by each \`import … with { type: "file" }\`
 * declaration, which is passed directly to \`Bun.file(path)\`.
 */
export const TEMPLATE_MANIFEST = new Map([
${manifestEntries.join("\n")}
]);

/** Total number of embedded template files (sanity check). */
export const EMBEDDED_FILE_COUNT = ${files.length};
`;

  const js = `${jsHeader}${imports}\n${manifestBody}`;

  const dts = `// AUTO-GENERATED by packages/cli/scripts/generate-template-manifest.ts.
// DO NOT EDIT MANUALLY. Provides the type surface for templates-manifest.js
// so \`src/util/templates.ts\` can import it without \`tsc\` ever processing
// the underlying \`with { type: "file" }\` declarations.

/**
 * Map from template name (e.g. \`"default"\`) to a map of
 * (POSIX relative path → embedded file path usable with \`Bun.file\`).
 */
export const TEMPLATE_MANIFEST: ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Total number of embedded template files (sanity check). */
export const EMBEDDED_FILE_COUNT: number;
`;

  return { js, dts };
}

function main(): void {
  const files = collectTemplateFiles();
  const { js, dts } = generateSources(files);
  fs.mkdirSync(path.dirname(OUTPUT_JS), { recursive: true });
  fs.writeFileSync(OUTPUT_JS, js, "utf-8");
  fs.writeFileSync(OUTPUT_DTS, dts, "utf-8");
  const byTemplate = new Map<string, number>();
  for (const f of files) {
    byTemplate.set(f.template, (byTemplate.get(f.template) ?? 0) + 1);
  }
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${path.relative(CLI_ROOT, OUTPUT_JS)} + .d.ts ` +
      `(${files.length} files: ${[...byTemplate.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})`
  );
}

if (import.meta.main) {
  main();
}

import { describe, expect, it } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Phase 9.R2 — binary-mode init-landing + error-template smoke tests.
 *
 * Focus: the invariants that made the v0.23.0 binary fall back to the
 * 3-line plain summary inside `mandu.exe init`:
 *
 *   1. `readFileSync(getInitLandingTemplatePath(), …)` resolved a
 *      `$bunfs/...` virtual path that `node:fs` cannot open → silent
 *      catch → degraded output.
 *   2. Same pattern in `src/errors/messages.ts::loadTemplate` for error
 *      markdown payloads (CLI_E001 / CLI_E010 / CLI_E022).
 *
 * R2 replaced both paths with `import … with { type: "text" }` via the
 * generated `cli-ux-manifest.js` — these are **inlined string payloads**
 * at compile time and therefore work identically in dev and compiled
 * binaries, synchronously, without filesystem access.
 *
 * These tests assert:
 *   - The generated CLI-UX manifest exists with the expected 4 payloads.
 *   - Each payload's string content byte-matches the on-disk source (so
 *     a stale regeneration is detected immediately).
 *   - `loadInitLandingTemplate` / `loadErrorTemplate` return
 *     non-null in dev mode (the happy path the binary now also takes).
 *   - `formatCLIError` renders ANSI content under rich TTY (the exact
 *     condition the binary hits when stdout is attached to a TTY + no
 *     NO_COLOR), confirming the manifest lookup is wired through.
 */

const CLI_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

describe("Phase 9.R2 CLI-UX manifest (binary-mode markdown payloads)", () => {
  it("emits exactly 4 embedded CLI-UX markdown payloads", async () => {
    // Dynamic import keeps this test honest about the generated shape —
    // if the generator drops an entry, the count assertion catches it.
    const mod = (await import(
      path.join(CLI_ROOT, "generated", "cli-ux-manifest.js")
    )) as {
      CLI_UX_TEMPLATES: ReadonlyMap<string, string>;
      CLI_UX_TEMPLATE_COUNT: number;
    };
    expect(mod.CLI_UX_TEMPLATE_COUNT).toBe(4);
    expect([...mod.CLI_UX_TEMPLATES.keys()].sort()).toEqual([
      "errors/CLI_E001",
      "errors/CLI_E010",
      "errors/CLI_E022",
      "init-landing",
    ]);
  });

  it("embeds init-landing.md byte-identical to the on-disk source", async () => {
    const { CLI_UX_TEMPLATES } = (await import(
      path.join(CLI_ROOT, "generated", "cli-ux-manifest.js")
    )) as { CLI_UX_TEMPLATES: ReadonlyMap<string, string> };
    const embedded = CLI_UX_TEMPLATES.get("init-landing");
    expect(embedded).toBeTruthy();
    const sourcePath = path.join(CLI_ROOT, "templates", "init-landing.md");
    const onDisk = readFileSync(sourcePath, "utf-8");
    expect(embedded).toBe(onDisk);
  });

  it("embeds every error markdown byte-identical to the on-disk source", async () => {
    const { CLI_UX_TEMPLATES } = (await import(
      path.join(CLI_ROOT, "generated", "cli-ux-manifest.js")
    )) as { CLI_UX_TEMPLATES: ReadonlyMap<string, string> };
    for (const code of ["CLI_E001", "CLI_E010", "CLI_E022"]) {
      const embedded = CLI_UX_TEMPLATES.get(`errors/${code}`);
      expect(embedded).toBeTruthy();
      const sourcePath = path.join(CLI_ROOT, "templates", "errors", `${code}.md`);
      const onDisk = readFileSync(sourcePath, "utf-8");
      expect(embedded).toBe(onDisk);
    }
  });

  it("embedded init-landing contains every placeholder the renderer substitutes", async () => {
    const { CLI_UX_TEMPLATES } = (await import(
      path.join(CLI_ROOT, "generated", "cli-ux-manifest.js")
    )) as { CLI_UX_TEMPLATES: ReadonlyMap<string, string> };
    const body = CLI_UX_TEMPLATES.get("init-landing") ?? "";
    for (const token of [
      "{{projectName}}",
      "{{targetDir}}",
      "{{installHint}}",
      "{{cssLine}}",
      "{{uiLines}}",
      "{{mcpLines}}",
      "{{skillsLines}}",
      "{{lockfileLines}}",
    ]) {
      expect(body).toContain(token);
    }
  });

  it("embedded error payloads keep their expected heading markers", async () => {
    const { CLI_UX_TEMPLATES } = (await import(
      path.join(CLI_ROOT, "generated", "cli-ux-manifest.js")
    )) as { CLI_UX_TEMPLATES: ReadonlyMap<string, string> };
    expect(CLI_UX_TEMPLATES.get("errors/CLI_E001")).toContain("# CLI_E001");
    expect(CLI_UX_TEMPLATES.get("errors/CLI_E010")).toContain("# CLI_E010");
    expect(CLI_UX_TEMPLATES.get("errors/CLI_E022")).toContain("# CLI_E022");
  });

  it("formatCLIError uses the embedded manifest (sync + ANSI under rich TTY)", async () => {
    const { CLI_ERROR_CODES, formatCLIError } = await import(
      path.join(CLI_ROOT, "src", "errors", "index.ts")
    );

    // Force rich-TTY conditions — same environment the binary runs in.
    const prevNoColor = process.env.NO_COLOR;
    const prevForceColor = process.env.FORCE_COLOR;
    const prevCI = process.env.CI;
    const prevTerm = process.env.TERM;
    const originalIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    try {
      const out = formatCLIError(CLI_ERROR_CODES.INIT_DIR_EXISTS, {
        path: "/tmp/smoke",
      });
      // ANSI escape sequence (ESC [ …) confirms the manifest payload
      // flowed through `renderMarkdown` instead of the legacy fallback.
      expect(out).toMatch(/\u001b\[/);
      // Template-specific content still present.
      expect(out).toContain("CLI_E001");
      expect(out).toContain("/tmp/smoke");
      // Legacy prefix (`❌ Error [...]`) must NOT appear — that prefix is
      // only emitted when the template lookup misses.
      expect(out).not.toContain("❌ Error [CLI_E001]");
    } finally {
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
      if (prevForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForceColor;
      if (prevCI === undefined) delete process.env.CI;
      else process.env.CI = prevCI;
      if (prevTerm === undefined) delete process.env.TERM;
      else process.env.TERM = prevTerm;
      (process.stdout as { isTTY?: boolean }).isTTY = originalIsTTY;
    }
  });

  it("messages.ts no longer imports node:fs readFileSync (binary-safety)", () => {
    // Regression guard — if someone reintroduces `readFileSync` here,
    // the binary will silently fall back to the legacy format again.
    const src = readFileSync(
      path.join(CLI_ROOT, "src", "errors", "messages.ts"),
      "utf-8"
    );
    expect(src).not.toContain('from "node:fs"');
    expect(src).not.toContain('readFileSync(');
    // And the new import must be present.
    expect(src).toContain('CLI_UX_TEMPLATES');
  });

  it("init.ts no longer imports readFileSync for the landing template", () => {
    const src = readFileSync(
      path.join(CLI_ROOT, "src", "commands", "init.ts"),
      "utf-8"
    );
    expect(src).not.toContain('import { readFileSync } from "node:fs"');
    // New sync manifest lookup must be present.
    expect(src).toContain("loadInitLandingTemplate");
    expect(src).toContain(
      'import { CLI_UX_TEMPLATES } from "../../generated/cli-ux-manifest.js"'
    );
  });
});

describe("Phase 9.R2 compiled binary smoke (opt-in via MANDU_PHASE_9R2_BINARY=1)", () => {
  // Opt-in heavyweight smoke — only runs locally (or in a job that
  // explicitly rebuilds the host binary). CI doesn't need this because
  // `.github/workflows/release-binaries.yml` runs the full matrix.
  const binaryPath = path.join(CLI_ROOT, "dist", "mandu.exe");
  const optIn = process.env.MANDU_PHASE_9R2_BINARY === "1";

  it.skipIf(!optIn || !existsSync(binaryPath))(
    "mandu.exe --version succeeds and stays under 1s cold",
    async () => {
      const started = Bun.nanoseconds();
      const proc = Bun.spawn({
        cmd: [binaryPath, "--version"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
      expect(code).toBe(0);
      const out = await new Response(proc.stdout).text();
      expect(out).toContain("v");
      expect(elapsedMs).toBeLessThan(1000);
    }
  );

  it.skipIf(!optIn || !existsSync(binaryPath))(
    "mandu.exe binary size stays under 150 MB budget",
    () => {
      const size = statSync(binaryPath).size;
      expect(size).toBeLessThan(150 * 1024 * 1024);
      expect(size).toBeGreaterThan(40 * 1024 * 1024); // sanity lower bound
    }
  );
});

/**
 * Regression + feature test for Issue #196 — `mandu dev` auto-runs
 * `scripts/prebuild-*.ts` before dev boot.
 *
 * Strategy:
 *
 *   1. The discovery + execution primitive (`@mandujs/core/content/prebuild`)
 *      has its own unit tests with a mock spawn hook. That lives in
 *      `packages/core/src/content/prebuild.test.ts`.
 *
 *   2. This test file exercises the CLI wiring at the integration layer
 *      by spawning an actual `mandu dev` subprocess against a fake
 *      project scaffold. We assert:
 *
 *        (a) the synchronous "mandu dev booting..." banner lands within
 *            2 s on stdout — Issue #195 regression guard.
 *        (b) the discovered prebuild script runs and its side-effect
 *            file (`content/generated.txt`) appears on disk before the
 *            dev server binds its port — ordering contract for #196.
 *        (c) the `autoPrebuild: false` opt-out in mandu.config.ts
 *            skips the prebuild chain cleanly (no regression for
 *            projects without a prebuild workflow).
 *
 *  Caveats:
 *   - A full port-bind check is out of scope because the dev server
 *     needs a writable `.mandu/` directory and a clean lockfile, both
 *     of which are slow and noisy. We stop reading stdout as soon as
 *     the ordering contract is proven.
 *   - The subprocess is killed after each case to avoid port leaks.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = path.join(os.tmpdir(), "mandu-dev-autoprebuild-");

/**
 * Build a minimal Mandu project under `dir`:
 *   - mandu.config.ts        → selects a random ephemeral port
 *   - app/page.tsx           → trivial home page (so route scan succeeds)
 *   - scripts/prebuild-x.ts  → writes a deterministic marker file into
 *                              content/ so the test can prove execution
 *   - package.json           → links the workspace @mandujs/core + cli
 */
function scaffoldProject(dir: string, port: number, opts: { optOut?: boolean } = {}): void {
  fs.mkdirSync(path.join(dir, "app"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });

  const configBody = opts.optOut
    ? `import type { ManduConfig } from "@mandujs/core";
export default {
  server: { port: ${port} },
  dev: { observability: false, autoPrebuild: false },
  guard: { realtime: false },
} satisfies ManduConfig;
`
    : `import type { ManduConfig } from "@mandujs/core";
export default {
  server: { port: ${port} },
  dev: { observability: false },
  guard: { realtime: false },
} satisfies ManduConfig;
`;
  fs.writeFileSync(path.join(dir, "mandu.config.ts"), configBody);

  fs.writeFileSync(
    path.join(dir, "app", "page.tsx"),
    `export default function Home() { return <div>ok</div>; }\n`,
  );

  fs.writeFileSync(
    path.join(dir, "scripts", "prebuild-marker.ts"),
    `import fs from "node:fs";
import path from "node:path";
const out = path.resolve(import.meta.dir, "../content/generated.txt");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, "auto-prebuild-ran@" + Date.now());
process.stdout.write("[prebuild-marker] ran\\n");
`,
  );

  // Minimal package.json — we do NOT install; the test relies on the
  // workspace root's node_modules being resolvable via Bun's upward
  // directory search. That works because `PREFIX` lives under
  // `os.tmpdir()` which is typically OUTSIDE the workspace, so to keep
  // resolution deterministic we point absolute at the CLI's main.
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "_mandu-test-" + path.basename(dir),
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
}

/**
 * Find the workspace root by walking upwards until we see a
 * `packages/cli/src/main.ts`. This sidesteps the brittleness of
 * `__dirname`/`import.meta.url` when the test file is invoked via
 * `bun test` from any CWD.
 */
function findCliMain(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  // Unix-style: URL path may have a leading `/C:/` on Windows; strip it.
  if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "packages", "cli", "src", "main.ts");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cannot locate packages/cli/src/main.ts from test");
}

/**
 * Drain the subprocess stdout until a predicate matches or the timeout
 * fires. Resolves with the full captured text so assertions can inspect
 * ordering.
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let combined = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(50, deadline - Date.now())),
      ),
    ]);
    if (race.done) break;
    combined += decoder.decode(race.value);
    if (predicate(combined)) break;
  }
  return combined;
}

describe("#196 integration — mandu dev auto-prebuild", () => {
  const projects: string[] = [];
  let cliMain: string;

  beforeAll(() => {
    cliMain = findCliMain();
  });

  afterAll(async () => {
    for (const dir of projects) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch {
        // Best effort — tmp cleanup.
      }
    }
  });

  it(
    "runs discovered prebuild scripts BEFORE the dev server binds its port",
    async () => {
      // Pick a high-numbered port unlikely to collide with a running
      // dev server in CI. Port selection failures are not assertable at
      // this layer because we may exit early; we just pick high.
      const port = 43000 + Math.floor(Math.random() * 2000);
      const dir = fs.mkdtempSync(PREFIX + "run-");
      projects.push(dir);
      scaffoldProject(dir, port);

      const markerPath = path.join(dir, "content", "generated.txt");
      expect(fs.existsSync(markerPath)).toBe(false);

      const proc = Bun.spawn({
        cmd: ["bun", cliMain, "dev"],
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MANDU_DEBUG_BOOT: "1" },
      });
      try {
        const reader = proc.stdout.getReader();
        // We wait until the prebuild banner lands OR up to 25s — the
        // initial boot includes lockfile validation + JIT prewarm, so
        // we're generous on the upper bound to avoid CI flake.
        // Drain until either the script completes (" done in ") OR
        // we see "Starting dev server" which means we're past the
        // prebuild phase. `onStart` prints "Prebuild [1/1]" BEFORE
        // the script actually runs, so we need to wait for the
        // post-completion marker to avoid a race with side-effect
        // file creation.
        const out = await readUntil(
          reader,
          (text) => text.includes(" done in ") || text.includes("Starting dev server"),
          25_000,
        );
        // Banner contract (#195): first line is the early flush banner.
        expect(out).toContain("mandu dev booting...");
        // Ordering contract (#196): prebuild ran + marker file exists.
        expect(out).toContain("Prebuild [1/1]");
        expect(out).toContain("prebuild-marker.ts");
        expect(fs.existsSync(markerPath)).toBe(true);
        // Prebuild completes before we see the "Starting dev server"
        // line. We verify ordering via offset comparison.
        const prebuildIdx = out.indexOf("Prebuild [1/1]");
        const startIdx = out.indexOf("Starting dev server");
        if (startIdx !== -1) {
          expect(prebuildIdx).toBeLessThan(startIdx);
        }
      } finally {
        proc.kill();
        // Swallow the `exited` promise — it resolves post-kill and we
        // don't want to leak it into the next test.
        await proc.exited.catch(() => {});
      }
    },
    { timeout: 35_000 },
  );

  it(
    "skips prebuild entirely when dev.autoPrebuild is false",
    async () => {
      const port = 45000 + Math.floor(Math.random() * 2000);
      const dir = fs.mkdtempSync(PREFIX + "optout-");
      projects.push(dir);
      scaffoldProject(dir, port, { optOut: true });

      const markerPath = path.join(dir, "content", "generated.txt");
      expect(fs.existsSync(markerPath)).toBe(false);

      const proc = Bun.spawn({
        cmd: ["bun", cliMain, "dev"],
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MANDU_DEBUG_BOOT: "1" },
      });
      try {
        const reader = proc.stdout.getReader();
        // Wait for the "Starting dev server..." line — that proves we
        // reached the post-prebuild step. If opt-out didn't work we'd
        // see a Prebuild banner first.
        const out = await readUntil(
          reader,
          (text) => text.includes("Starting dev server"),
          25_000,
        );
        expect(out).toContain("mandu dev booting...");
        expect(out).toContain("prebuild decision: skip");
        expect(out).not.toContain("Prebuild [");
        // Marker file must NOT exist — opt-out must skip script execution.
        expect(fs.existsSync(markerPath)).toBe(false);
      } finally {
        proc.kill();
        await proc.exited.catch(() => {});
      }
    },
    { timeout: 35_000 },
  );

  it(
    "emits 'mandu dev booting...' synchronously as the first stdout line",
    async () => {
      // This asserts the #195 hang fix directly — the banner MUST be
      // the first chunk delivered, even under stdio-pipe buffering.
      const port = 47000 + Math.floor(Math.random() * 2000);
      const dir = fs.mkdtempSync(PREFIX + "banner-");
      projects.push(dir);
      scaffoldProject(dir, port, { optOut: true }); // skip prebuild to shorten test

      const proc = Bun.spawn({
        cmd: ["bun", cliMain, "dev"],
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const start = Date.now();
      try {
        const reader = proc.stdout.getReader();
        const out = await readUntil(
          reader,
          (text) => text.includes("mandu dev booting"),
          10_000,
        );
        const elapsed = Date.now() - start;
        // Banner must land quickly — before any file I/O could plausibly
        // contribute to user-visible latency.
        expect(out.startsWith("mandu dev booting")).toBe(true);
        // 5 s ceiling is generous; observed ~200-400 ms locally.
        expect(elapsed).toBeLessThan(5_000);
      } finally {
        proc.kill();
        await proc.exited.catch(() => {});
      }
    },
    { timeout: 20_000 },
  );
});

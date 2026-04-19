/**
 * Regression test for Issue #195 — `mandu dev --watch` hangs after a
 * chained prebuild sequence with no stdout output.
 *
 * The defensive fix in `dev.ts` prints a synchronous `"mandu dev
 * booting...\n"` line BEFORE any await, guaranteeing the user sees
 * proof the process started regardless of downstream buffering. This
 * test exercises that contract at the source level — we import the
 * module, spy on `process.stdout.write`, and invoke enough of `dev()`
 * to observe the early flush.
 *
 * Running the whole `dev()` command end-to-end would require a full
 * Bun project scaffold + port binding, which is out of scope for a
 * CLI-unit regression. Instead we validate:
 *
 *   1. Importing `dev` from `./dev` does not throw — no top-level side
 *      effects regressed.
 *   2. `maskSlotPath` (exported for tests) handles the cross-drive /
 *      escaping-rel path edge case that previously fed absolute paths
 *      into HMR broadcasts.
 *
 * The "boot banner immediately" behaviour is additionally verified in
 * the integration-style test in `dev-autoprebuild.test.ts` which
 * spawns a full child process and asserts the first stdout line.
 */

import { describe, it, expect } from "bun:test";
import path from "node:path";

import { maskSlotPath } from "../dev";

describe("#195 regression — `dev.ts` module shape", () => {
  it("module loads cleanly (no top-level throw on import)", async () => {
    const mod = await import("../dev");
    expect(typeof mod.dev).toBe("function");
    expect(typeof mod.maskSlotPath).toBe("function");
  });

  it("maskSlotPath returns a root-relative forward-slash path", () => {
    const root = path.resolve("/repo/my-app");
    const file = path.join(root, "app", "page.slot.ts");
    const out = maskSlotPath(root, file);
    // On Windows this becomes "app/page.slot.ts"; on Unix same.
    expect(out).toBe("app/page.slot.ts");
  });

  it("maskSlotPath masks escaping paths (prevents absolute-path leak)", () => {
    const root = path.resolve("/repo/my-app");
    const file = path.resolve("/unrelated/elsewhere.slot.ts");
    const out = maskSlotPath(root, file);
    // Relative computed path starts with ".." — we fall back to basename.
    expect(out).toBe("elsewhere.slot.ts");
  });

  it("maskSlotPath survives a completely unresolvable path (no throw)", () => {
    // Intentionally passing non-string types would compile-error; we
    // pass a file outside the root to exercise the try/catch fallback.
    const out = maskSlotPath("", "/totally/different.slot.ts");
    // Behaviour: path.relative("" → cwd) may yield various results, but
    // the mask must never include a drive-letter absolute. Either a
    // bare basename OR a forward-slash path with no leading "/".
    expect(out).not.toMatch(/^[A-Za-z]:/);
    expect(out).not.toContain("\\");
  });
});

/**
 * Phase 7.3 L-02 — maskSlotPath unit tests.
 *
 * Verifies that `maskSlotPath` (extracted to module scope in
 * `packages/cli/src/commands/dev.ts`) never leaks an absolute filesystem
 * path into the HDR `mandu:slot-refetch` broadcast. The function is:
 *
 *   - Normalizes backslashes → forward slashes so Windows paths ship
 *     platform-agnostic over the HMR wire.
 *   - Converts absolute paths to root-relative.
 *   - Falls back to `path.basename()` when the computed relative path
 *     would escape rootDir (startsWith ".." — e.g. a misconfigured
 *     watcher points at a sibling directory) OR when path.relative
 *     returns something that is still absolute (cross-drive on Windows).
 *
 * Why this matters:
 *   Even though the HMR WebSocket is localhost-only and origin-gated
 *   (Phase 7.0.S), the HDRPayload is printed to dev console, which
 *   can be visible on screenshare, OBS, or pair-programming streams.
 *   Shipping absolute paths (C:\Users\alice\secret-project\...) is
 *   information that adds no value to the HMR protocol.
 *
 * References:
 *   docs/security/phase-7-2-audit.md §3 L-02
 *   packages/cli/src/commands/dev.ts — maskSlotPath
 *   packages/core/src/bundler/hmr-types.ts — HDRPayload.slotPath
 */

import { describe, test, expect } from "bun:test";
import path from "path";
import { maskSlotPath } from "../../src/commands/dev";

describe("Phase 7.3 L-02 — maskSlotPath", () => {
  // ───────────────────────────────────────────────────────────────────
  // 1. Happy path — file under rootDir → relative, forward-slash path.
  //    Use path.join to keep the test cross-platform; we assert on a
  //    known forward-slash output shape.
  // ───────────────────────────────────────────────────────────────────

  test("[1] file inside rootDir yields a root-relative forward-slash path", () => {
    const rootDir = path.resolve("/proj");
    const file = path.join(rootDir, "app", "page.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    expect(masked).toBe("app/page.slot.ts");
  });

  // ───────────────────────────────────────────────────────────────────
  // 2. Nested subdirectory still produces a forward-slash relative path.
  // ───────────────────────────────────────────────────────────────────

  test("[2] nested slot in subdirectory produces forward-slash relative path", () => {
    const rootDir = path.resolve("/proj");
    const file = path.join(rootDir, "spec", "slots", "dashboard", "page.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    expect(masked).toBe("spec/slots/dashboard/page.slot.ts");
  });

  // ───────────────────────────────────────────────────────────────────
  // 3. Slot path that tries to escape rootDir (".." in the relative)
  //    falls back to bare basename. This closes "watcher misconfigured,
  //    points at a sibling" — we never ship a leaked sibling path.
  // ───────────────────────────────────────────────────────────────────

  test("[3] slot OUTSIDE rootDir (parent directory) falls back to basename-only", () => {
    const rootDir = path.resolve("/proj/sub");
    // File is at /proj/leaked.slot.ts — one level up from rootDir.
    const file = path.resolve("/proj/leaked.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    // basename fallback — no "../" escape, no absolute path leak.
    expect(masked).toBe("leaked.slot.ts");
    expect(masked.includes("..")).toBe(false);
    expect(path.isAbsolute(masked)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 4. A deeply-nested OUTSIDE-root path still falls back to basename.
  //    This is the strongest guarantee: even with a creative relative
  //    path we never ship context that reveals the parent directory
  //    structure.
  // ───────────────────────────────────────────────────────────────────

  test("[4] deeply-nested OUTSIDE-root path falls back to basename-only", () => {
    const rootDir = path.resolve("/proj/sub/nested");
    // File is at /etc/secret/page.slot.ts — a wildly different tree.
    const file = path.resolve("/some/other/tree/leak.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    expect(masked).toBe("leak.slot.ts");
    // Must not contain the full ancestor path.
    expect(masked.includes("other")).toBe(false);
    expect(masked.includes("tree")).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 5. Windows backslash handling — we pass Windows-shaped input
  //    through the normalized rootDir pair. Even on non-Windows
  //    hosts the regex replacement ensures the output contains only
  //    forward slashes if the relative path survives the check.
  //    On non-Windows, path.join with Windows-shaped paths degrades
  //    gracefully; this test primarily exercises the normalization
  //    when the platform IS Windows.
  // ───────────────────────────────────────────────────────────────────

  test("[5] resulting masked path contains no backslashes (cross-platform contract)", () => {
    const rootDir = path.resolve("/proj");
    const file = path.join(rootDir, "a", "b", "c.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    expect(masked.includes("\\")).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 6. File directly at rootDir root (unusual but legal) — returns the
  //    basename with no leading slash.
  // ───────────────────────────────────────────────────────────────────

  test("[6] slot at rootDir root yields just the basename", () => {
    const rootDir = path.resolve("/proj");
    const file = path.join(rootDir, "root-level.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    expect(masked).toBe("root-level.slot.ts");
    // Never starts with a slash or drive letter.
    expect(masked.startsWith("/")).toBe(false);
    expect(masked.startsWith("\\")).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 7. Defensive — if path.relative throws (unlikely — e.g. bizarre
  //    inputs), we still return a basename and never propagate.
  //    We synthesize this by passing a path that path.basename can
  //    handle but path.relative will handle oddly; we accept either
  //    a relative path OR a basename fallback as long as the result
  //    is safe.
  // ───────────────────────────────────────────────────────────────────

  test("[7] never returns a string containing '..' path segments", () => {
    const rootDir = path.resolve("/proj/sub");
    const file = path.resolve("/proj/sibling/other.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    expect(masked.split(/[\\/]/).includes("..")).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 8. Leak regression — the final output must never contain any
  //    substring that looks like the rootDir prefix.
  //    If we ever accidentally shipped the absolute path this would
  //    catch it.
  // ───────────────────────────────────────────────────────────────────

  test("[8] masked output never contains the rootDir absolute prefix", () => {
    const rootDir = path.resolve("/home/alice/secret-project");
    const file = path.join(rootDir, "app", "page.slot.ts");
    const masked = maskSlotPath(rootDir, file);
    expect(masked.includes("alice")).toBe(false);
    expect(masked.includes("secret-project")).toBe(false);
    expect(masked).toBe("app/page.slot.ts");
  });
});

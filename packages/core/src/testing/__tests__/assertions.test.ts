/**
 * Phase C.1 — tests for the Mandu-specific assertion primitives.
 *
 * Each primitive has 6-8 cases per spec §C.1. They keep the entire suite
 * hermetic — no network, no Playwright process, no real streaming server.
 * Tests that need a page/response supply minimal mocks of the
 * `Page`/`Response` shape each primitive consumes.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  expectContract,
  expectNavigation,
  waitForIsland,
  assertStreamBoundary,
  expectSemantic,
  ContractAssertionError,
  NavigationAssertionError,
  HydrationTimeoutError,
  StreamBoundaryError,
  SemanticDivergenceError,
  type PlaywrightLikePage,
  type PlaywrightIslandPage,
  type ExpectSemanticPage,
  type OracleQueueEntry,
} from "../assertions";

// ────────────────────────────────────────────────────────────────────────────
// expectContract
// ────────────────────────────────────────────────────────────────────────────

describe("expectContract", () => {
  const Signup = z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
  });

  test("happy path — valid payload passes strict", () => {
    const r = expectContract(
      { userId: "550e8400-e29b-41d4-a716-446655440000", email: "a@b.com" },
      Signup,
    );
    expect(r.status).toBe("pass");
    expect(r.violations.length).toBe(0);
  });

  test("strict fails when a required field is missing", () => {
    expect(() =>
      expectContract({ email: "a@b.com" }, Signup),
    ).toThrow(ContractAssertionError);
  });

  test("loose tolerates extra keys", () => {
    const Open = Signup.passthrough();
    const r = expectContract(
      { userId: "550e8400-e29b-41d4-a716-446655440000", email: "a@b.com", extra: 1 },
      Open,
      { mode: "loose" },
    );
    expect(r.status).toBe("pass");
  });

  test("drift-tolerant returns warnings without throwing", () => {
    const r = expectContract(
      { userId: "not-a-uuid", email: "bad" },
      Signup,
      { mode: "drift-tolerant" },
    );
    expect(r.status).toBe("fail");
    expect(r.violations.every((v) => v.severity === "warning")).toBe(true);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  test("ignorePaths skips the listed paths", () => {
    // email violation is ignored; only userId would remain.
    expect(() =>
      expectContract({ userId: "not", email: "bad" }, Signup, {
        ignorePaths: [".userId"],
      }),
    ).toThrow(ContractAssertionError);
    // But if we ignore both, it passes in loose mode (strict still flags extras only).
    const r = expectContract(
      { userId: "550e8400-e29b-41d4-a716-446655440000", email: "a@b.com" },
      Signup,
      { ignorePaths: [".userId", ".email"] },
    );
    expect(r.status).toBe("pass");
  });

  test("strict flags extra keys in the actual payload", () => {
    // Zod default strips unknown keys — expectContract surfaces them as
    // strict-mode violations by walking actual vs parsed.
    expect(() =>
      expectContract(
        { userId: "550e8400-e29b-41d4-a716-446655440000", email: "a@b.com", extra: 1 },
        Signup,
        { mode: "strict" },
      ),
    ).toThrow(/extra key/i);
  });

  test("violations carry machine-readable paths", () => {
    try {
      expectContract({ userId: "bad", email: "a@b.com" }, Signup);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractAssertionError);
      const ce = err as ContractAssertionError;
      expect(ce.violations[0].path).toBe(".userId");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// expectNavigation
// ────────────────────────────────────────────────────────────────────────────

interface MockPage extends PlaywrightLikePage {
  __pushUrl(u: string): void;
}

function makeMockPage(initial: string): MockPage {
  let current = initial;
  const listeners: Array<(frame: { url: () => string }) => void> = [];
  const page: MockPage = {
    url: () => current,
    on(event, listener) {
      if (event === "framenavigated") listeners.push(listener as typeof listeners[number]);
    },
    off(event, listener) {
      if (event !== "framenavigated") return;
      const idx = listeners.indexOf(listener as typeof listeners[number]);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    async waitForURL(pattern) {
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (pattern instanceof RegExp ? pattern.test(current) : current === pattern || current.includes(String(pattern))) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    __pushUrl(u) {
      current = u;
      for (const l of listeners) l({ url: () => u });
    },
  };
  return page;
}

describe("expectNavigation", () => {
  test("passes when final URL matches regex", async () => {
    const page = makeMockPage("http://localhost/");
    setTimeout(() => page.__pushUrl("http://localhost/kr"), 5);
    const r = await expectNavigation(page, { from: "http://localhost/", to: /\/kr(\/|$)/ });
    expect(r.status).toBe("pass");
    expect(r.chain.some((u) => u.endsWith("/kr"))).toBe(true);
  });

  test("passes exact redirect count", async () => {
    const page = makeMockPage("http://localhost/");
    setTimeout(() => page.__pushUrl("http://localhost/kr"), 5);
    setTimeout(() => page.__pushUrl("http://localhost/kr/home"), 10);
    const r = await expectNavigation(page, {
      from: "http://localhost/",
      to: /\/kr\/home/,
      redirectCount: 2,
      timeoutMs: 200,
    });
    expect(r.status).toBe("pass");
  });

  test("fails when final URL mismatches", async () => {
    const page = makeMockPage("http://localhost/");
    let threw = false;
    try {
      await expectNavigation(page, { to: /\/never-matches/, timeoutMs: 50 });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(NavigationAssertionError);
    }
    expect(threw).toBe(true);
  });

  test("captures chain for later diagnosis", async () => {
    const page = makeMockPage("http://localhost/");
    setTimeout(() => page.__pushUrl("http://localhost/a"), 5);
    setTimeout(() => page.__pushUrl("http://localhost/b"), 10);
    try {
      await expectNavigation(page, { to: /\/NEVER/, timeoutMs: 50 });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(NavigationAssertionError);
      const ne = err as NavigationAssertionError;
      expect(ne.detail.chain.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("fails when redirectCount mismatches", async () => {
    const page = makeMockPage("http://localhost/");
    setTimeout(() => page.__pushUrl("http://localhost/x"), 5);
    setTimeout(() => page.__pushUrl("http://localhost/y"), 10);
    let threw = false;
    try {
      await expectNavigation(page, {
        from: "http://localhost/",
        to: /\/y/,
        redirectCount: 1,
        timeoutMs: 200,
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(NavigationAssertionError);
    }
    expect(threw).toBe(true);
  });

  test("enforces maxRedirects ≤", async () => {
    const page = makeMockPage("http://localhost/");
    setTimeout(() => page.__pushUrl("http://localhost/a"), 5);
    setTimeout(() => page.__pushUrl("http://localhost/b"), 10);
    setTimeout(() => page.__pushUrl("http://localhost/c"), 15);
    let threw = false;
    try {
      await expectNavigation(page, {
        from: "http://localhost/",
        to: /\/c/,
        maxRedirects: 1,
        timeoutMs: 200,
      });
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// waitForIsland
// ────────────────────────────────────────────────────────────────────────────

function makeIslandPage(state: { strategy?: string; hydrated?: boolean; mounted?: boolean; delayMs?: number }): PlaywrightIslandPage & {
  hydrate: () => void;
} {
  const s = { mounted: true, hydrated: false, ...state };
  let hydrateTick = 0;
  return {
    async evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T> {
      // We don't actually run `fn` in a browser — we inspect the shape
      // of `arg` and answer based on our mock state. The primitive's
      // strategy-sniffing evaluate call passes a bare `name` (string);
      // the polling evaluate call passes `{ name, state }`.
      hydrateTick++;
      if (state.delayMs && hydrateTick > 2) s.hydrated = true;
      if (typeof arg === "string") {
        // strategy sniff
        return (s.strategy ?? null) as unknown as T;
      }
      if (!s.mounted) return { mounted: false, hydrated: false } as unknown as T;
      if ((arg as { state: string }).state === "visible") return { mounted: true, hydrated: true } as unknown as T;
      return { mounted: s.mounted, hydrated: s.hydrated } as unknown as T;
    },
    hydrate() {
      s.hydrated = true;
    },
  };
}

describe("waitForIsland", () => {
  test("resolves immediately for hydration:none strategy", async () => {
    const page = makeIslandPage({ strategy: "none" });
    const before = Date.now();
    await waitForIsland(page, "Legal", { timeoutMs: 200 });
    expect(Date.now() - before).toBeLessThan(200);
  });

  test("resolves when data-hydrated flips true", async () => {
    const page = makeIslandPage({ strategy: "visible", delayMs: 50 });
    await waitForIsland(page, "Cart", { timeoutMs: 500 });
  });

  test("throws HydrationTimeoutError after timeout", async () => {
    const page = makeIslandPage({ strategy: "visible", hydrated: false });
    let threw = false;
    try {
      await waitForIsland(page, "NeverHydrates", { timeoutMs: 100 });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(HydrationTimeoutError);
      expect((err as HydrationTimeoutError).detail.island).toBe("NeverHydrates");
    }
    expect(threw).toBe(true);
  });

  test("state:visible passes once the island mounts", async () => {
    const page = makeIslandPage({ strategy: "visible" });
    await waitForIsland(page, "Banner", { timeoutMs: 100, state: "visible" });
  });

  test("evaluate exception retries the poll", async () => {
    let calls = 0;
    const page: PlaywrightIslandPage = {
      async evaluate<T, A>(_fn: (arg: A) => T, arg: A): Promise<T> {
        calls++;
        if (calls === 1) throw new Error("transient");
        if (typeof arg === "string") return "visible" as unknown as T;
        return { mounted: true, hydrated: true } as unknown as T;
      },
    };
    await waitForIsland(page, "Retry", { timeoutMs: 500 });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("detail payload has failure.v1 shape", async () => {
    const page = makeIslandPage({ strategy: "visible", hydrated: false });
    try {
      await waitForIsland(page, "X", { timeoutMs: 30 });
      throw new Error("unreachable");
    } catch (err) {
      const he = err as HydrationTimeoutError;
      expect(he.kind).toBe("hydration_timeout");
      expect(typeof he.detail.waitedMs).toBe("number");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// assertStreamBoundary
// ────────────────────────────────────────────────────────────────────────────

function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/html" } });
}

describe("assertStreamBoundary", () => {
  test("passes when shell and tail match", async () => {
    const res = makeStreamResponse([
      "<!DOCTYPE html><html><head></head><body>shell",
      "<!--$--><div>slow</div><!--/$--><script>islands</script>",
    ]);
    const r = await assertStreamBoundary(res, {
      shellChunkContains: ["<!DOCTYPE", "<html"],
      boundaryCount: 1,
      tailChunkContainsAnyOf: ["<script"],
    });
    expect(r.status).toBe("pass");
    expect(r.boundaryOpenCount).toBe(1);
    expect(r.boundaryCloseCount).toBe(1);
  });

  test("counts multiple boundaries", async () => {
    const res = makeStreamResponse([
      "<html>",
      "<!--$-->a<!--/$-->",
      "<!--$-->b<!--/$-->",
      "<!--$-->c<!--/$-->",
    ]);
    const r = await assertStreamBoundary(res, { boundaryCount: 3 });
    expect(r.boundaryOpenCount).toBe(3);
  });

  test("fails when boundaryCount mismatches", async () => {
    const res = makeStreamResponse(["<html><!--$-->x<!--/$-->"]);
    let threw = false;
    try {
      await assertStreamBoundary(res, { boundaryCount: 2 });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(StreamBoundaryError);
    }
    expect(threw).toBe(true);
  });

  test("fails when shell missing expected marker", async () => {
    const res = makeStreamResponse(["<html>body only"]);
    let threw = false;
    try {
      await assertStreamBoundary(res, { shellChunkContains: ["<!DOCTYPE"] });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(StreamBoundaryError);
    }
    expect(threw).toBe(true);
  });

  test("fails when shell exceeds byte budget", async () => {
    const big = "<html>" + "x".repeat(5_000);
    const res = makeStreamResponse([big]);
    let threw = false;
    try {
      await assertStreamBoundary(res, { firstChunkMaxSizeBytes: 1_000 });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(StreamBoundaryError);
    }
    expect(threw).toBe(true);
  });

  test("fails when tail misses all candidates", async () => {
    const res = makeStreamResponse(["<html>", "end without script"]);
    let threw = false;
    try {
      await assertStreamBoundary(res, { tailChunkContainsAnyOf: ["<script", "island"] });
    } catch (err) {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("throws on empty body", async () => {
    const res = new Response(null);
    let threw = false;
    try {
      await assertStreamBoundary(res, {});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("passes with no expectations (sanity)", async () => {
    const res = makeStreamResponse(["<html>"]);
    const r = await assertStreamBoundary(res, {});
    expect(r.status).toBe("pass");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// expectSemantic
// ────────────────────────────────────────────────────────────────────────────

describe("expectSemantic", () => {
  let tmp: string;
  let priorDetOnly: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mandu-expect-semantic-"));
    priorDetOnly = process.env.MANDU_ATE_DETERMINISTIC_ONLY;
    delete process.env.MANDU_ATE_DETERMINISTIC_ONLY;
  });

  afterEach(() => {
    if (priorDetOnly === undefined) {
      delete process.env.MANDU_ATE_DETERMINISTIC_ONLY;
    } else {
      process.env.MANDU_ATE_DETERMINISTIC_ONLY = priorDetOnly;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakePage(): ExpectSemanticPage {
    return {
      async content() {
        return "<html><body>hi</body></html>";
      },
      async screenshot() {
        return new Uint8Array([1, 2, 3]);
      },
    };
  }

  test("enqueues a pending entry with pass status", async () => {
    const page = fakePage();
    const r = expectSemantic(page, "user sees error near field", {
      repoRoot: tmp,
      specPath: "tests/demo.spec.ts",
      runId: "run-1",
    });
    expect(r.status).toBe("pass");
    expect(r.deferred).toBe(true);

    // Give the microtask a moment to flush artifacts.
    await new Promise((r) => setTimeout(r, 20));

    const queue = join(tmp, ".mandu", "ate-oracle-queue.jsonl");
    expect(existsSync(queue)).toBe(true);
    const line = readFileSync(queue, "utf8").trim();
    const entry: OracleQueueEntry = JSON.parse(line);
    expect(entry.status).toBe("pending");
    expect(entry.claim).toContain("error");
    expect(entry.assertionId).toBe(r.assertionId);
  });

  test("CI DETERMINISTIC_ONLY skips file writes entirely", () => {
    process.env.MANDU_ATE_DETERMINISTIC_ONLY = "1";
    const page = fakePage();
    const r = expectSemantic(page, "non-blocking claim", {
      repoRoot: tmp,
      specPath: "tests/ci.spec.ts",
    });
    expect(r.status).toBe("pass");
    expect(r.deferred).toBe(true);
    const queue = join(tmp, ".mandu", "ate-oracle-queue.jsonl");
    expect(existsSync(queue)).toBe(false);
  });

  test("assertionId is stable across calls with same (claim, specPath)", () => {
    const page = fakePage();
    const a = expectSemantic(page, "same claim", { repoRoot: tmp, specPath: "x.spec.ts", runId: "1" });
    const b = expectSemantic(page, "same claim", { repoRoot: tmp, specPath: "x.spec.ts", runId: "2" });
    expect(a.assertionId).toBe(b.assertionId);
  });

  test("promoteVerdicts promotes past failed verdicts to runtime fail", async () => {
    // Manually seed a past `failed` verdict with a matching assertionId.
    const claim = "promote this one";
    const specPath = "tests/promote.spec.ts";
    // Use expectSemantic to generate the id deterministically, then
    // write a synthetic `failed` entry before invoking again.
    const first = expectSemantic(fakePage(), claim, {
      repoRoot: tmp,
      specPath,
      runId: "r1",
    });
    const queuePath = join(tmp, ".mandu", "ate-oracle-queue.jsonl");
    mkdirSync(dirname(queuePath), { recursive: true });
    const failed: OracleQueueEntry = {
      assertionId: first.assertionId,
      specPath,
      runId: "r1",
      claim,
      artifactPath: tmp,
      status: "failed",
      verdict: { judgedBy: "agent", reason: "missing error color", timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    };
    writeFileSync(queuePath, `${JSON.stringify(failed)}\n`);

    // Now call with promoteVerdicts — should throw.
    let threw = false;
    try {
      expectSemantic(fakePage(), claim, {
        repoRoot: tmp,
        specPath,
        promoteVerdicts: true,
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(SemanticDivergenceError);
    }
    expect(threw).toBe(true);
  });

  test("promoteVerdicts ignores pending + passed entries", () => {
    const claim = "still open";
    const specPath = "tests/pend.spec.ts";
    const first = expectSemantic(fakePage(), claim, {
      repoRoot: tmp,
      specPath,
      runId: "r1",
    });
    const queuePath = join(tmp, ".mandu", "ate-oracle-queue.jsonl");
    const passed: OracleQueueEntry = {
      assertionId: first.assertionId,
      specPath,
      runId: "r1",
      claim,
      artifactPath: tmp,
      status: "passed",
      verdict: { judgedBy: "agent", reason: "looks good", timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    };
    writeFileSync(queuePath, `${JSON.stringify(passed)}\n`);

    // No throw — still pass.
    const r = expectSemantic(fakePage(), claim, {
      repoRoot: tmp,
      specPath,
      promoteVerdicts: true,
    });
    expect(r.status).toBe("pass");
  });

  test("capture:dom only writes dom.html", async () => {
    const page = fakePage();
    const r = expectSemantic(page, "dom only", {
      repoRoot: tmp,
      specPath: "tests/d.spec.ts",
      runId: "run-dom",
      capture: "dom",
    });
    await new Promise((r) => setTimeout(r, 30));
    const artifactDir = join(tmp, ".mandu", "ate-oracle-queue", "run-dom", r.assertionId);
    expect(existsSync(join(artifactDir, "dom.html"))).toBe(true);
    expect(existsSync(join(artifactDir, "screenshot.png"))).toBe(false);
  });

  test("explicit injected snapshots bypass page calls", async () => {
    // Page has no methods — we provide explicit artifacts.
    const r = expectSemantic(
      {},
      "injected",
      {
        repoRoot: tmp,
        specPath: "tests/inj.spec.ts",
        runId: "inj-1",
        domSnapshot: "<html><body>injected</body></html>",
        screenshotBytes: new Uint8Array([9, 9]),
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    const dir = join(tmp, ".mandu", "ate-oracle-queue", "inj-1", r.assertionId);
    expect(readFileSync(join(dir, "dom.html"), "utf8")).toContain("injected");
  });

  test("appends (not overwrites) across invocations", async () => {
    expectSemantic(fakePage(), "first", {
      repoRoot: tmp,
      specPath: "tests/a.spec.ts",
      runId: "r1",
    });
    expectSemantic(fakePage(), "second", {
      repoRoot: tmp,
      specPath: "tests/a.spec.ts",
      runId: "r1",
    });
    const queue = join(tmp, ".mandu", "ate-oracle-queue.jsonl");
    const lines = readFileSync(queue, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });
});

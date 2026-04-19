#!/usr/bin/env bun
/**
 * Phase 17 — long-run dev server heap smoke test.
 *
 * Spawns `mandu dev` on `demo/auth-starter`, issues a burst of HTTP
 * requests, samples `/_mandu/heap` at a fixed cadence, and asserts the
 * final RSS is within a growth budget.
 *
 * NOT part of the default `bun test` sweep — too flaky on shared CI
 * runners. Run locally before releases; see docs/ops/heap-smoke.md.
 *
 *   bun run scripts/smoke/dev-server-heap.ts
 *
 * Exit code 0 = pass, 1 = fail.
 */

import path from "path";
import { createServer } from "node:net";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

// -------------------------------------------------------------
// Config
// -------------------------------------------------------------

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const CONFIG = {
  demo: process.env.MANDU_SMOKE_DEMO || "demo/auth-starter",
  requests: envNumber("MANDU_SMOKE_REQUESTS", 1000),
  durationMs: envNumber("MANDU_SMOKE_DURATION_MS", 60_000),
  sampleIntervalMs: envNumber("MANDU_SMOKE_SAMPLE_INTERVAL_MS", 5_000),
  // Budget is in MB so it reads cleanly from the CLI.
  maxGrowthMb: envNumber("MANDU_SMOKE_MAX_GROWTH_MB", 100),
  startupTimeoutMs: envNumber("MANDU_SMOKE_STARTUP_TIMEOUT_MS", 60_000),
};

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

const MB = 1024 * 1024;
const toMB = (bytes: number) => Math.round(bytes / MB);

function log(msg: string) {
  console.log(`[smoke] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

/** Find a free TCP port by asking the OS. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("failed to allocate port"));
      });
    });
  });
}

async function fetchHeap(port: number): Promise<{ rss: number; heapUsed: number; external: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_mandu/heap`);
    if (!res.ok) return null;
    const body = (await res.json()) as { process: { rss: number; heapUsed: number; external: number } };
    return body.process;
  } catch {
    return null;
  }
}

async function waitForServer(port: number, deadlineMs: number): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < deadlineMs) {
    const snap = await fetchHeap(port);
    if (snap) return;
    await Bun.sleep(500);
  }
  throw new Error(`dev server did not become healthy within ${deadlineMs} ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------
// Main
// -------------------------------------------------------------

async function main() {
  const demoDir = path.resolve(repoRoot, CONFIG.demo);
  const port = await pickFreePort();
  log(`demo=${CONFIG.demo} port=${port}`);

  // 1. Spawn `mandu dev`. We use `bun run mandu` from the demo package to
  //    pick up the workspace resolution.
  const startedAt = performance.now();
  const proc = Bun.spawn(["bun", "run", "mandu", "dev", "--port", String(port)], {
    cwd: demoDir,
    env: {
      ...process.env,
      // Force observability on (in case future default changes)
      MANDU_DEBUG_HEAP: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const cleanup = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* noop */
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    await waitForServer(port, CONFIG.startupTimeoutMs);
    const startupMs = Math.round(performance.now() - startedAt);
    log(`dev server started in ${(startupMs / 1000).toFixed(1)}s`);

    // 2. Initial heap snapshot.
    const initial = await fetchHeap(port);
    if (!initial) fail("could not read initial heap snapshot");
    log(
      `initial rss=${toMB(initial.rss)}MB heap=${toMB(initial.heapUsed)}MB external=${toMB(initial.external)}MB`,
    );

    // 3. Issue requests concurrently but paced to stretch across durationMs.
    //    We batch in waves so the test itself doesn't OOM if the dev server
    //    handles requests slowly.
    const totalRequests = CONFIG.requests;
    const gapMs = CONFIG.durationMs / totalRequests;
    const samples: Array<{ t: number; rss: number; heapUsed: number; external: number }> = [];

    const sampler = setInterval(async () => {
      const snap = await fetchHeap(port);
      if (!snap) return;
      const t = Math.round((performance.now() - startedAt) / 1000);
      const delta = snap.rss - initial.rss;
      samples.push({ t, ...snap });
      log(
        `t=${t}s rss=${toMB(snap.rss)}MB heap=${toMB(snap.heapUsed)}MB external=${toMB(snap.external)}MB (delta=${delta >= 0 ? "+" : ""}${toMB(delta)}MB)`,
      );
    }, CONFIG.sampleIntervalMs);
    // Keep sampler from pinning the event loop.
    if (typeof sampler.unref === "function") sampler.unref();

    const requestStart = performance.now();
    const requestPromises: Promise<void>[] = [];
    for (let i = 0; i < totalRequests; i++) {
      const launch = async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/`);
          // Drain the body so the server can release buffers.
          await r.arrayBuffer();
        } catch {
          // Ignore individual failures — the heap growth signal is what matters.
        }
      };
      requestPromises.push(launch());
      await sleep(gapMs);
    }
    await Promise.all(requestPromises);
    clearInterval(sampler);
    const requestElapsedMs = performance.now() - requestStart;
    log(`${totalRequests} requests sent in ${(requestElapsedMs / 1000).toFixed(1)}s`);

    // 4. Final heap snapshot (after a short settle window for post-GC state).
    await sleep(1000);
    const final = await fetchHeap(port);
    if (!final) fail("could not read final heap snapshot");

    const peakRss = Math.max(initial.rss, final.rss, ...samples.map((s) => s.rss));
    const delta = final.rss - initial.rss;
    const deltaMb = toMB(delta);
    const budgetMb = CONFIG.maxGrowthMb;

    log(
      `summary: initial=${toMB(initial.rss)}MB peak=${toMB(peakRss)}MB final=${toMB(final.rss)}MB delta=${delta >= 0 ? "+" : ""}${deltaMb}MB budget=${budgetMb}MB`,
    );

    if (deltaMb > budgetMb) {
      fail(`RSS grew by ${deltaMb} MB (> ${budgetMb} MB budget)`);
    }
    log("PASS");
  } finally {
    cleanup();
  }
}

await main();

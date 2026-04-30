/**
 * Mandu Hydration Benchmark
 * Playwright 기반 하이드레이션 성능 측정
 */

import { chromium, type Browser, type Page } from "playwright";
import fs from "fs/promises";
import path from "path";
import { createServer } from "node:net";

interface BenchmarkResult {
  name: string;
  ttfb: number;          // Time to First Byte (ms)
  fcp: number;           // First Contentful Paint (ms)
  tti: number;           // Time to Interactive (ms)
  hydrationTime: number; // Island hydration 완료 시간 (ms)
  bundleSize: number;    // Total JS bundle size (KB)
  memoryUsage: number;   // Peak memory usage (MB)
  islandCount: number;   // Number of islands hydrated
  totalIslandCount?: number;
  hydrationErrorCount?: number;
  hydrationErrors?: string[];
}

interface BenchmarkConfig {
  url: string;
  runs: number;
  warmupRuns: number;
  throttle?: "3G" | "4G" | "none";
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
}

interface HydrationMetrics {
  hydrationTime: number;
  islandCount: number;
  totalIslandCount: number;
  errorCount: number;
  errors: string[];
}

const HYDRATION_TIMEOUT_MS = 10_000;

const NETWORK_CONDITIONS = {
  "3G": {
    offline: false,
    downloadThroughput: (500 * 1024) / 8, // 500 Kbps
    uploadThroughput: (500 * 1024) / 8,
    latency: 400,
  },
  "4G": {
    offline: false,
    downloadThroughput: (4 * 1024 * 1024) / 8, // 4 Mbps
    uploadThroughput: (3 * 1024 * 1024) / 8,
    latency: 20,
  },
  none: null,
};

interface BrowserSession {
  browser: Browser;
  cleanup: () => Promise<void>;
}

interface CdpHost {
  endpoint: string;
  cleanup: () => Promise<void>;
}

interface CdpTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

interface CdpClient {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  waitForEvent<T = unknown>(method: string, timeoutMs?: number): Promise<T>;
  close(): void;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("Failed to resolve a free port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function resolveExistingWindowsBrowser(preferred: "chrome" | "msedge"): Promise<string | null> {
  const candidates = preferred === "chrome"
    ? [
        path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : [
        path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep searching
    }
  }

  return null;
}

async function waitForCdpEndpoint(port: number, timeoutMs = 15_000): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (!response.ok) {
        throw new Error(`CDP endpoint returned ${response.status}`);
      }
      const data = await response.json() as { webSocketDebuggerUrl?: string };
      if (!data.webSocketDebuggerUrl) {
        throw new Error("CDP endpoint did not return webSocketDebuggerUrl");
      }
      return endpoint;
    } catch (error) {
      lastError = error;
      await Bun.sleep(250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function terminateBrowserProcess(proc: Bun.Subprocess<"ignore", "ignore", "ignore">): Promise<void> {
  if (process.platform === "win32") {
    const killer = Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await killer.exited;
    return;
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}

async function launchCdpHost(preferred: "chrome" | "msedge"): Promise<CdpHost> {
  const executable = await resolveExistingWindowsBrowser(preferred);
  if (!executable) {
    throw new Error(`System ${preferred} executable not found`);
  }

  const port = await getFreePort();
  const userDataDir = await fs.mkdtemp(path.join(process.env.TEMP || process.cwd(), `mandu-perf-${preferred}-`));
  const proc = Bun.spawn(
    [
      executable,
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    }
  );

  try {
    const endpoint = await waitForCdpEndpoint(port);
    return {
      endpoint,
      cleanup: async () => {
        await terminateBrowserProcess(proc);
        try {
          await proc.exited;
        } catch {
          // ignore
        }
        try {
          await fs.rm(userDataDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },
    };
  } catch (error) {
    await terminateBrowserProcess(proc);
    try {
      await proc.exited;
    } catch {
      // ignore
    }
    try {
      await fs.rm(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

async function launchBrowserViaCdp(preferred: "chrome" | "msedge"): Promise<BrowserSession> {
  const host = await launchCdpHost(preferred);

  try {
    const browser = await chromium.connectOverCDP(host.endpoint, { timeout: 15_000 });

    return {
      browser,
      cleanup: async () => {
        try {
          await browser.close();
        } catch {
          // ignore
        }
        await host.cleanup();
      },
    };
  } catch (error) {
    await host.cleanup();
    throw error;
  }
}

async function launchBenchmarkBrowser(): Promise<BrowserSession> {
  const attempts: Array<{
    label: string;
    run: () => Promise<BrowserSession>;
  }> = [
    {
      label: "bundled chromium",
      run: async () => {
        const browser = await chromium.launch({ headless: true, timeout: 45_000 });
        return {
          browser,
          cleanup: async () => {
            await browser.close();
          },
        };
      },
    },
  ];

  if (process.platform === "win32") {
    attempts.push(
      {
        label: "system chrome over CDP",
        run: () => launchBrowserViaCdp("chrome"),
      },
      {
        label: "system msedge over CDP",
        run: () => launchBrowserViaCdp("msedge"),
      },
    );
  }

  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      console.log(`   Browser launch attempt: ${attempt.label}`);
      return await attempt.run();
    } catch (error) {
      lastError = error;
      console.warn(`   Browser launch failed: ${attempt.label}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function createCdpTarget(endpoint: string): Promise<CdpTarget> {
  const encodedUrl = encodeURIComponent("about:blank");
  const methods: Array<"PUT" | "GET"> = ["PUT", "GET"];
  let lastError: unknown;

  for (const method of methods) {
    try {
      const response = await fetch(`${endpoint}/json/new?${encodedUrl}`, { method });
      if (!response.ok) {
        throw new Error(`CDP /json/new returned ${response.status}`);
      }
      const data = await response.json() as Partial<CdpTarget>;
      if (!data.id || !data.webSocketDebuggerUrl) {
        throw new Error(`CDP /json/new returned an invalid target: ${JSON.stringify(data)}`);
      }
      return {
        id: data.id,
        webSocketDebuggerUrl: data.webSocketDebuggerUrl,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function closeCdpTarget(endpoint: string, targetId: string): Promise<void> {
  try {
    await fetch(`${endpoint}/json/close/${targetId}`);
  } catch {
    // ignore
  }
}

async function readWebSocketMessageData(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return String(data);
}

function connectRawCdp(webSocketDebuggerUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map<
      number,
      {
        method: string;
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >();
    const eventWaiters = new Map<
      string,
      Array<{
        resolve: (value: unknown) => void;
        reject: (reason?: unknown) => void;
        timeout: ReturnType<typeof setTimeout>;
      }>
    >();
    let nextId = 1;
    let opened = false;

    const rejectAll = (error: Error): void => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
      pending.clear();

      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
      }
      eventWaiters.clear();
    };

    const openTimeout = setTimeout(() => {
      if (!opened) {
        socket.close();
        reject(new Error("Raw CDP WebSocket did not open in 15000ms"));
      }
    }, 15_000);

    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(openTimeout);
      resolve({
        send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Raw CDP WebSocket is not open"));
          }

          const id = nextId++;
          const timeout = setTimeout(() => {
            const waiter = pending.get(id);
            if (!waiter) return;
            pending.delete(id);
            waiter.reject(new Error(`CDP command timed out: ${method}`));
          }, 30_000);

          const promise = new Promise<T>((commandResolve, commandReject) => {
            pending.set(id, {
              method,
              resolve: (value) => commandResolve(value as T),
              reject: commandReject,
              timeout,
            });
          });

          socket.send(JSON.stringify({ id, method, params }));
          return promise;
        },
        waitForEvent<T = unknown>(method: string, timeoutMs = 30_000): Promise<T> {
          return new Promise<T>((eventResolve, eventReject) => {
            const timeout = setTimeout(() => {
              const waiters = eventWaiters.get(method);
              if (waiters) {
                const index = waiters.findIndex((waiter) => waiter.timeout === timeout);
                if (index >= 0) waiters.splice(index, 1);
              }
              eventReject(new Error(`CDP event timed out: ${method}`));
            }, timeoutMs);

            const waiters = eventWaiters.get(method) ?? [];
            waiters.push({
              resolve: (value) => eventResolve(value as T),
              reject: eventReject,
              timeout,
            });
            eventWaiters.set(method, waiters);
          });
        },
        close(): void {
          socket.close();
        },
      });
    });

    socket.addEventListener("message", (event) => {
      void (async () => {
        const raw = await readWebSocketMessageData(event.data);
        const message = JSON.parse(raw) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message?: string };
        };

        if (message.id !== undefined) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          clearTimeout(waiter.timeout);
          if (message.error) {
            waiter.reject(new Error(message.error.message ?? `CDP command failed: ${waiter.method}`));
          } else {
            waiter.resolve(message.result);
          }
          return;
        }

        if (message.method) {
          const waiters = eventWaiters.get(message.method);
          const waiter = waiters?.shift();
          if (!waiter) return;
          clearTimeout(waiter.timeout);
          waiter.resolve(message.params);
        }
      })().catch((error) => {
        rejectAll(error instanceof Error ? error : new Error(String(error)));
      });
    });

    socket.addEventListener("error", () => {
      const error = new Error("Raw CDP WebSocket failed");
      if (!opened) {
        clearTimeout(openTimeout);
        reject(error);
      } else {
        rejectAll(error);
      }
    });

    socket.addEventListener("close", () => {
      clearTimeout(openTimeout);
      rejectAll(new Error("Raw CDP WebSocket closed"));
    });
  });
}

async function evaluateCdp<T>(
  client: CdpClient,
  expression: string,
  awaitPromise = false,
): Promise<T> {
  const response = await client.send<{
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "CDP Runtime.evaluate failed",
    );
  }

  return response.result?.value as T;
}

function resolveCdpLoadEvent(waitUntil: BenchmarkConfig["waitUntil"]): string {
  if (waitUntil === "domcontentloaded") return "Page.domContentEventFired";
  return "Page.loadEventFired";
}

async function runRawCdpPage(
  endpoint: string,
  config: BenchmarkConfig,
): Promise<BenchmarkResult> {
  const target = await createCdpTarget(endpoint);
  const client = await connectRawCdp(target.webSocketDebuggerUrl);

  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Network.enable");

    if (config.throttle && config.throttle !== "none") {
      await client.send("Network.emulateNetworkConditions", NETWORK_CONDITIONS[config.throttle]!);
    }

    const loadEvent = client.waitForEvent(resolveCdpLoadEvent(config.waitUntil), 45_000);
    await client.send("Page.navigate", { url: config.url });
    await loadEvent;

    const perfMetrics = await evaluateCdp<{ ttfb: number; fcp: number; tti: number }>(
      client,
      `new Promise((resolve) => {
        const navigationEntry = performance.getEntriesByType("navigation")[0];
        const ttfb = navigationEntry?.responseStart || 0;
        const paintEntries = performance.getEntriesByType("paint");
        const fcpEntry = paintEntries.find((entry) => entry.name === "first-contentful-paint");
        const fcp = fcpEntry?.startTime || 0;
        let tti = fcp;
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === "longtask") {
              tti = Math.max(tti, entry.startTime + entry.duration);
            }
          }
        });
        try {
          observer.observe({ entryTypes: ["longtask"] });
        } catch {}
        setTimeout(() => {
          observer.disconnect();
          resolve({ ttfb, fcp, tti });
        }, 2000);
      })`,
      true,
    );

    const hydrationMetrics = await evaluateCdp<HydrationMetrics>(
      client,
      `new Promise((resolve) => {
        const startTime = performance.now();
        const totalIslands = document.querySelectorAll("[data-mandu-island]").length;
        const collectErrors = () => Array.from(document.querySelectorAll("[data-mandu-error]")).map((element) => {
          const id = element.getAttribute("data-mandu-island") || "(unknown)";
          const src = element.getAttribute("data-mandu-src") || "(unknown src)";
          const reason = element.getAttribute("data-mandu-error") || "true";
          return id + " failed hydration from " + src + " (" + reason + ")";
        });
        if (totalIslands === 0) {
          resolve({ hydrationTime: 0, islandCount: 0, totalIslandCount: 0, errorCount: 0, errors: [] });
          return;
        }
        const checkInterval = setInterval(() => {
          const hydrated = document.querySelectorAll("[data-mandu-hydrated]").length;
          const errors = collectErrors();
          if (hydrated >= totalIslands) {
            clearInterval(checkInterval);
            resolve({
              hydrationTime: performance.now() - startTime,
              islandCount: hydrated,
              totalIslandCount: totalIslands,
              errorCount: errors.length,
              errors,
            });
            return;
          }
          if (errors.length > 0) {
            clearInterval(checkInterval);
            resolve({
              hydrationTime: ${HYDRATION_TIMEOUT_MS},
              islandCount: hydrated,
              totalIslandCount: totalIslands,
              errorCount: errors.length,
              errors,
            });
          }
        }, 10);
        setTimeout(() => {
          clearInterval(checkInterval);
          const hydrated = document.querySelectorAll("[data-mandu-hydrated]").length;
          const errors = collectErrors();
          resolve({
            hydrationTime: performance.now() - startTime,
            islandCount: hydrated,
            totalIslandCount: totalIslands,
            errorCount: errors.length,
            errors,
          });
        }, ${HYDRATION_TIMEOUT_MS});
      })`,
      true,
    );

    const bundleSize = await evaluateCdp<number>(
      client,
      `(() => {
        const entries = performance.getEntriesByType("resource");
        return entries
          .filter((entry) => entry.initiatorType === "script" && entry.name.includes(".mandu"))
          .reduce((sum, entry) => sum + (entry.transferSize || 0), 0) / 1024;
      })()`,
    );

    const heap = await client
      .send<{ usedSize?: number }>("Runtime.getHeapUsage")
      .catch(() => ({ usedSize: 0 }));

    return {
      name: "Raw CDP run",
      ttfb: perfMetrics.ttfb,
      fcp: perfMetrics.fcp,
      tti: perfMetrics.tti,
      hydrationTime: hydrationMetrics.hydrationTime,
      bundleSize,
      memoryUsage: (heap.usedSize ?? 0) / (1024 * 1024),
      islandCount: hydrationMetrics.islandCount,
      totalIslandCount: hydrationMetrics.totalIslandCount,
      hydrationErrorCount: hydrationMetrics.errorCount,
      hydrationErrors: hydrationMetrics.errors,
    };
  } finally {
    client.close();
    await closeCdpTarget(endpoint, target.id);
  }
}

async function runRawCdpBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult[]> {
  if (process.platform !== "win32") {
    throw new Error("Raw CDP fallback is currently only wired for Windows system browsers");
  }

  const attempts: Array<"chrome" | "msedge"> = ["chrome", "msedge"];
  let lastError: unknown;

  for (const preferred of attempts) {
    let host: CdpHost | null = null;
    try {
      console.log(`   Raw CDP fallback attempt: system ${preferred}`);
      host = await launchCdpHost(preferred);
      const results: BenchmarkResult[] = [];

      for (let i = 0; i < config.warmupRuns; i++) {
        await runRawCdpPage(host.endpoint, config);
        console.log(`   Raw CDP warmup ${i + 1}/${config.warmupRuns} ✓`);
      }

      for (let i = 0; i < config.runs; i++) {
        const result = await runRawCdpPage(host.endpoint, config);
        result.name = `Run ${i + 1}`;
        results.push(result);
        console.log(
          `   Raw CDP run ${i + 1}/${config.runs}: TTI=${result.tti.toFixed(0)}ms, Hydration=${result.hydrationTime.toFixed(0)}ms`,
        );
      }

      return results;
    } catch (error) {
      lastError = error;
      console.warn(`   Raw CDP fallback failed: system ${preferred}`);
    } finally {
      if (host) {
        await host.cleanup();
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function measureHydration(page: Page): Promise<{
  hydrationTime: number;
  islandCount: number;
  totalIslandCount: number;
  errorCount: number;
  errors: string[];
}> {
  return page.evaluate((timeoutMs) => {
    return new Promise((resolve) => {
      const startTime = performance.now();
      let _hydratedCount = 0;
      const totalIslands = document.querySelectorAll("[data-mandu-island]").length;
      const collectErrors = () => Array.from(document.querySelectorAll("[data-mandu-error]")).map((element) => {
        const id = element.getAttribute("data-mandu-island") || "(unknown)";
        const src = element.getAttribute("data-mandu-src") || "(unknown src)";
        const reason = element.getAttribute("data-mandu-error") || "true";
        return `${id} failed hydration from ${src} (${reason})`;
      });

      if (totalIslands === 0) {
        resolve({ hydrationTime: 0, islandCount: 0, totalIslandCount: 0, errorCount: 0, errors: [] });
        return;
      }

      // 모든 Island hydration 완료 대기
      const checkInterval = setInterval(() => {
        const hydrated = document.querySelectorAll("[data-mandu-hydrated]").length;
        const errors = collectErrors();
        if (hydrated >= totalIslands) {
          clearInterval(checkInterval);
          const endTime = performance.now();
          resolve({
            hydrationTime: endTime - startTime,
            islandCount: hydrated,
            totalIslandCount: totalIslands,
            errorCount: errors.length,
            errors,
          });
          return;
        }

        if (errors.length > 0) {
          clearInterval(checkInterval);
          resolve({
            hydrationTime: timeoutMs,
            islandCount: hydrated,
            totalIslandCount: totalIslands,
            errorCount: errors.length,
            errors,
          });
        }
      }, 10);

      // 타임아웃 (10초)
      setTimeout(() => {
        clearInterval(checkInterval);
        const hydrated = document.querySelectorAll("[data-mandu-hydrated]").length;
        const errors = collectErrors();
        resolve({
          hydrationTime: performance.now() - startTime,
          islandCount: hydrated,
          totalIslandCount: totalIslands,
          errorCount: errors.length,
          errors,
        });
      }, timeoutMs);
    });
  }, HYDRATION_TIMEOUT_MS);
}

async function measurePerformanceMetrics(page: Page): Promise<{
  ttfb: number;
  fcp: number;
  tti: number;
}> {
  const metrics = await page.evaluate(() => {
    return new Promise<{ ttfb: number; fcp: number; tti: number }>((resolve) => {
      const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const ttfb = navigationEntry?.responseStart || 0;

      // FCP 측정
      const paintEntries = performance.getEntriesByType("paint");
      const fcpEntry = paintEntries.find((e) => e.name === "first-contentful-paint");
      const fcp = fcpEntry?.startTime || 0;

      // TTI 근사값 (Long Tasks 기반)
      let tti = fcp;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "longtask") {
            tti = Math.max(tti, entry.startTime + entry.duration);
          }
        }
      });

      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // longtask not supported
      }

      // 안정화 대기 후 반환
      setTimeout(() => {
        observer.disconnect();
        resolve({ ttfb, fcp, tti });
      }, 2000);
    });
  });

  return metrics;
}

async function measureBundleSize(page: Page): Promise<number> {
  const resources = await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return entries
      .filter((e) => e.initiatorType === "script" && e.name.includes(".mandu"))
      .reduce((sum, e) => sum + (e.transferSize || 0), 0);
  });

  return resources / 1024; // KB
}

async function measureMemory(page: Page): Promise<number> {
  try {
    const metrics = await page.metrics();
    return (metrics.JSHeapUsedSize || 0) / (1024 * 1024); // MB
  } catch {
    return 0;
  }
}

async function runPlaywrightBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult[]> {
  const session = await launchBenchmarkBrowser();
  const browser = session.browser;
  const results: BenchmarkResult[] = [];
  const waitUntil = config.waitUntil || "load";

  console.log(`\n🏃 Benchmark: ${config.url}`);
  console.log(`   Runs: ${config.runs} (+ ${config.warmupRuns} warmup)`);
  console.log(`   Network: ${config.throttle || "none"}\n`);
  console.log(`   WaitUntil: ${waitUntil}\n`);

  try {
    // Warmup runs
    for (let i = 0; i < config.warmupRuns; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();

      if (config.throttle && config.throttle !== "none") {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.emulateNetworkConditions", NETWORK_CONDITIONS[config.throttle]!);
      }

      await page.goto(config.url, { waitUntil });
      await context.close();
      console.log(`   Warmup ${i + 1}/${config.warmupRuns} ✓`);
    }

    // Actual runs
    for (let i = 0; i < config.runs; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();

      if (config.throttle && config.throttle !== "none") {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.emulateNetworkConditions", NETWORK_CONDITIONS[config.throttle]!);
      }

      await page.goto(config.url, { waitUntil });

      const [perfMetrics, hydrationMetrics, bundleSize, memoryUsage] = await Promise.all([
        measurePerformanceMetrics(page),
        measureHydration(page),
        measureBundleSize(page),
        measureMemory(page),
      ]);

      results.push({
        name: `Run ${i + 1}`,
        ttfb: perfMetrics.ttfb,
        fcp: perfMetrics.fcp,
        tti: perfMetrics.tti,
        hydrationTime: hydrationMetrics.hydrationTime,
        bundleSize,
        memoryUsage,
        islandCount: hydrationMetrics.islandCount,
        totalIslandCount: hydrationMetrics.totalIslandCount,
        hydrationErrorCount: hydrationMetrics.errorCount,
        hydrationErrors: hydrationMetrics.errors,
      });

      await context.close();
      console.log(`   Run ${i + 1}/${config.runs}: TTI=${perfMetrics.tti.toFixed(0)}ms, Hydration=${hydrationMetrics.hydrationTime.toFixed(0)}ms`);
    }

    return results;
  } finally {
    await session.cleanup();
  }
}

async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult[]> {
  try {
    return await runPlaywrightBenchmark(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Playwright benchmark unavailable; trying raw CDP fallback. Cause: ${message}`);
    return runRawCdpBenchmark(config);
  }
}

function calculateStats(results: BenchmarkResult[]) {
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const min = (arr: number[]) => Math.min(...arr);
  const max = (arr: number[]) => Math.max(...arr);
  const p95 = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)];
  };

  const ttfbValues = results.map((r) => r.ttfb);
  const fcpValues = results.map((r) => r.fcp);
  const ttiValues = results.map((r) => r.tti);
  const hydrationValues = results.map((r) => r.hydrationTime);
  const bundleValues = results.map((r) => r.bundleSize);
  const memoryValues = results.map((r) => r.memoryUsage);

  return {
    ttfb: { avg: avg(ttfbValues), min: min(ttfbValues), max: max(ttfbValues), p95: p95(ttfbValues) },
    fcp: { avg: avg(fcpValues), min: min(fcpValues), max: max(fcpValues), p95: p95(fcpValues) },
    tti: { avg: avg(ttiValues), min: min(ttiValues), max: max(ttiValues), p95: p95(ttiValues) },
    hydration: { avg: avg(hydrationValues), min: min(hydrationValues), max: max(hydrationValues), p95: p95(hydrationValues) },
    bundleSize: { avg: avg(bundleValues) },
    memory: { avg: avg(memoryValues), max: max(memoryValues) },
    islandCount: results[0]?.islandCount || 0,
  };
}

function printReport(stats: ReturnType<typeof calculateStats>, config: BenchmarkConfig) {
  console.log("\n" + "=".repeat(60));
  console.log("📊 MANDU HYDRATION BENCHMARK REPORT");
  console.log("=".repeat(60));
  console.log(`URL: ${config.url}`);
  console.log(`Network: ${config.throttle || "No throttling"}`);
  console.log(`Runs: ${config.runs}`);
  console.log("-".repeat(60));

  console.log("\n🎯 PERFORMANCE METRICS\n");

  console.log(`  Time to First Byte (TTFB):`);
  console.log(`    Average: ${stats.ttfb.avg.toFixed(1)}ms`);
  console.log(`    Min/Max: ${stats.ttfb.min.toFixed(1)}ms / ${stats.ttfb.max.toFixed(1)}ms`);
  console.log(`    P95:     ${stats.ttfb.p95.toFixed(1)}ms`);

  console.log(`  First Contentful Paint (FCP):`);
  console.log(`    Average: ${stats.fcp.avg.toFixed(1)}ms`);
  console.log(`    Min/Max: ${stats.fcp.min.toFixed(1)}ms / ${stats.fcp.max.toFixed(1)}ms`);
  console.log(`    P95:     ${stats.fcp.p95.toFixed(1)}ms`);

  console.log(`\n  Time to Interactive (TTI):`);
  console.log(`    Average: ${stats.tti.avg.toFixed(1)}ms`);
  console.log(`    Min/Max: ${stats.tti.min.toFixed(1)}ms / ${stats.tti.max.toFixed(1)}ms`);
  console.log(`    P95:     ${stats.tti.p95.toFixed(1)}ms`);

  console.log(`\n  🏝️ Island Hydration:`);
  console.log(`    Islands: ${stats.islandCount}`);
  console.log(`    Average: ${stats.hydration.avg.toFixed(1)}ms`);
  console.log(`    Min/Max: ${stats.hydration.min.toFixed(1)}ms / ${stats.hydration.max.toFixed(1)}ms`);
  console.log(`    P95:     ${stats.hydration.p95.toFixed(1)}ms`);

  console.log(`\n  📦 Bundle Size:`);
  console.log(`    Total:   ${stats.bundleSize.avg.toFixed(1)}KB`);

  console.log(`\n  💾 Memory Usage:`);
  console.log(`    Average: ${stats.memory.avg.toFixed(1)}MB`);
  console.log(`    Peak:    ${stats.memory.max.toFixed(1)}MB`);

  // 등급 판정
  console.log("\n" + "-".repeat(60));
  console.log("📈 PERFORMANCE GRADE\n");

  const grades = {
    fcp: stats.fcp.avg < 1000 ? "A" : stats.fcp.avg < 2000 ? "B" : stats.fcp.avg < 3000 ? "C" : "D",
    tti: stats.tti.avg < 2000 ? "A" : stats.tti.avg < 4000 ? "B" : stats.tti.avg < 6000 ? "C" : "D",
    hydration: stats.hydration.avg < 100 ? "A" : stats.hydration.avg < 300 ? "B" : stats.hydration.avg < 500 ? "C" : "D",
    bundle: stats.bundleSize.avg < 50 ? "A" : stats.bundleSize.avg < 100 ? "B" : stats.bundleSize.avg < 200 ? "C" : "D",
  };

  console.log(`  FCP:        ${grades.fcp} (< 1000ms = A, < 2000ms = B)`);
  console.log(`  TTI:        ${grades.tti} (< 2000ms = A, < 4000ms = B)`);
  console.log(`  Hydration:  ${grades.hydration} (< 100ms = A, < 300ms = B)`);
  console.log(`  Bundle:     ${grades.bundle} (< 50KB = A, < 100KB = B)`);

  console.log("\n" + "=".repeat(60));
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  let jsonOut: string | null = null;
  let warmupRuns = 2;
  let waitUntil: BenchmarkConfig["waitUntil"] = "load";
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json-out") {
      const outputPath = args[i + 1];
      if (!outputPath) {
        throw new Error("--json-out requires a file path");
      }
      jsonOut = outputPath;
      i += 1;
      continue;
    }
    if (arg === "--warmup") {
      const warmupValue = args[i + 1];
      if (!warmupValue) {
        throw new Error("--warmup requires a number");
      }
      warmupRuns = parseInt(warmupValue);
      i += 1;
      continue;
    }
    if (arg === "--wait-until") {
      const waitValue = args[i + 1] as BenchmarkConfig["waitUntil"] | undefined;
      if (!waitValue) {
        throw new Error("--wait-until requires a value");
      }
      if (!["load", "domcontentloaded", "networkidle", "commit"].includes(waitValue)) {
        throw new Error(`Invalid waitUntil value: ${waitValue}`);
      }
      waitUntil = waitValue;
      i += 1;
      continue;
    }

    positional.push(arg);
  }

  const url = positional[0] || "http://localhost:3333/";
  const runs = parseInt(positional[1] || "5");
  const throttle = (positional[2] as "3G" | "4G" | "none") || "none";

  const config: BenchmarkConfig = {
    url,
    runs,
    warmupRuns,
    throttle,
    waitUntil,
  };

  try {
    const results = await runBenchmark(config);
    const stats = calculateStats(results);
    printReport(stats, config);

    // JSON 출력 (CI용)
    const jsonOutput = {
      timestamp: new Date().toISOString(),
      config,
      stats,
      raw: results,
    };

    console.log("\n📄 JSON Output:");
    console.log(JSON.stringify(jsonOutput, null, 2));

    if (jsonOut) {
      const resolvedPath = path.resolve(jsonOut);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, JSON.stringify(jsonOutput, null, 2), "utf8");
      console.log(`\n💾 Saved JSON output to ${resolvedPath}`);
    }
  } catch (error) {
    console.error("Benchmark failed:", error);
    process.exit(1);
  }
}

main();

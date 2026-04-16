import { Mandu } from "@mandujs/core";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampDelay(raw: string | null | undefined, fallback: number) {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(parsed, 2400));
}

export default Mandu.filling()
  .get(async (ctx) => {
    const url = new URL(ctx.request.url);
    const mode = url.searchParams.get("mode") ?? "summary";
    const delayMs = clampDelay(url.searchParams.get("delay"), 180);

    if (delayMs > 0) {
      await wait(delayMs);
    }

    if (mode === "error") {
      return ctx.json(
        {
          status: "error",
          mode,
          delayMs,
          requestId: crypto.randomUUID(),
          at: new Date().toISOString(),
          message: "Simulated server failure for the starter devtools lab.",
        },
        500,
      );
    }

    return ctx.ok({
      status: mode === "warning" ? "warning" : "ok",
      mode,
      delayMs,
      requestId: crypto.randomUUID(),
      at: new Date().toISOString(),
    });
  })
  .post(async (ctx) => {
    const url = new URL(ctx.request.url);
    const delayMs = clampDelay(url.searchParams.get("delay"), 220);
    const body = await ctx.request.json().catch(() => ({}));

    if (delayMs > 0) {
      await wait(delayMs);
    }

    return ctx.created({
      status: "created",
      mode: "post",
      delayMs,
      requestId: crypto.randomUUID(),
      at: new Date().toISOString(),
      body,
    });
  })
  .delete(async (ctx) => {
    const url = new URL(ctx.request.url);
    const mode = url.searchParams.get("mode") ?? "cleanup";
    const delayMs = clampDelay(url.searchParams.get("delay"), 120);
    const body = await ctx.request.json().catch(() => ({}));

    if (delayMs > 0) {
      await wait(delayMs);
    }

    return ctx.ok({
      status: "deleted",
      mode,
      delayMs,
      requestId: crypto.randomUUID(),
      at: new Date().toISOString(),
      body,
    });
  });

import { Mandu } from "@mandujs/core";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default Mandu.filling()
  .get((ctx) => {
    const requestId = crypto.randomUUID();

    return ctx.sse(async (sse) => {
      const steps = [
        { phase: "boot", delayMs: 160 },
        { phase: "collect", delayMs: 260 },
        { phase: "flush", delayMs: 180 },
      ];

      for (const [index, step] of steps.entries()) {
        if (ctx.request.signal.aborted) {
          break;
        }

        sse.event("progress", JSON.stringify({
          requestId,
          step: index + 1,
          phase: step.phase,
          at: new Date().toISOString(),
        }));

        await wait(step.delayMs);
      }

      if (!ctx.request.signal.aborted) {
        sse.event("done", JSON.stringify({
          requestId,
          status: "complete",
          at: new Date().toISOString(),
        }));
      }

      await sse.close();
    });
  });

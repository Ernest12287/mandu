import { describe, expect, it } from "bun:test";
import { createFetchHandler } from "../../src/runtime/handler";

describe("createFetchHandler", () => {
  it("passes rewritten requests to the downstream handler", async () => {
    const handler = createFetchHandler({
      router: {} as any,
      registry: {} as any,
      corsOptions: false,
      middlewareConfig: { matcher: ["/old"] },
      middlewareFn: async (ctx, next) => {
        ctx.rewrite("/new");
        return next();
      },
      handleRequest: async (req) => {
        return Response.json({ pathname: new URL(req.url).pathname });
      },
    });

    const response = await handler(new Request("http://localhost/old"));
    expect(await response.json()).toEqual({ pathname: "/new" });
  });

  it("injects matcher params into middleware context", async () => {
    const handler = createFetchHandler({
      router: {} as any,
      registry: {} as any,
      corsOptions: false,
      middlewareConfig: { matcher: ["/dashboard/:path*"] },
      middlewareFn: async (ctx) => Response.json(ctx.params),
      handleRequest: async () => Response.json({ ok: true }),
    });

    const response = await handler(new Request("http://localhost/dashboard/settings/profile"));
    expect(await response.json()).toEqual({ path: "settings/profile" });
  });
});

import { test, expect } from "@playwright/test";


test.describe("/api/chat--sse-stream", () => {
  test("sse-stream /api/chat", async ({ baseURL }) => {
    const url = (baseURL ?? "http://localhost:3333") + "/api/chat";
    const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
    expect(res.status).toBeLessThan(500);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/event-stream");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});

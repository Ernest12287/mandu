import { test, expect } from "@playwright/test";


test.describe("api:/api/categories/[id]", () => {
  test("GET /api/categories/[id]", async ({ baseURL }) => {
    const url = (baseURL ?? "http://localhost:3333") + "/api/categories/[id]";
    const res = await fetch(url, { method: "GET" });
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("content-type")).toBeTruthy();
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});

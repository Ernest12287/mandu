import { test, expect } from "@playwright/test";


test.describe("api:/api/todos", () => {
  test("GET /api/todos", async ({ baseURL }) => {
    const url = (baseURL ?? "http://localhost:3333") + "/api/todos";
    const res = await fetch(url, { method: "GET" });
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("content-type")).toBeTruthy();
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});

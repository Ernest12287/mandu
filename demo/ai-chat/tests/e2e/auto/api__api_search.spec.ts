import { test, expect } from "@playwright/test";


test.describe("api:/api/search", () => {
  test("GET /api/search", async ({ request, baseURL }) => {
    const url = (baseURL ?? "http://localhost:3333") + "/api/search";
    const res = await fetch(url, { method: "GET" });
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get("content-type")).toBeTruthy();
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
  test("L2 contract: /api/search", async ({ request }) => {
    // L2: API contract validation
    const response = await request.get("/api/search");
    expect(response.status()).toBeLessThan(500);
    const contentType = response.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/json");
    const responseBody = await response.json();
    expect(responseBody).toBeDefined();
  });
});

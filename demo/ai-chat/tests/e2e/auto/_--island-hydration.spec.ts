import { test, expect } from "@playwright/test";


test.describe("/--island-hydration", () => {
  test("island-hydration /", async ({ page, baseURL }) => {
    const url = (baseURL ?? "http://localhost:3333") + "/";
    await page.goto(url);
    await page.waitForSelector("[data-mandu-island]", { timeout: 5000 });
    const count = await page.locator("[data-mandu-island]").count();
    expect(count).toBeGreaterThan(0);
  });
});

import { test, expect } from "@playwright/test";


test.describe("/--ssr-verify", () => {
  test("ssr-verify /", async ({ page, baseURL }) => {
    const url = (baseURL ?? "http://localhost:3333") + "/";
    await page.goto(url);
    const html = await page.content();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
  });
});

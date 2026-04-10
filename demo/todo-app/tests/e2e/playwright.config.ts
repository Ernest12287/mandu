import { defineConfig } from "@playwright/test";

export default defineConfig({
  // NOTE: resolved relative to this config file (tests/e2e).
  testDir: ".",
  timeout: 60_000,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3333",
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["html", { outputFolder: "../../.mandu/reports/latest/playwright-html", open: "never" }],
    ["json", { outputFile: "../../.mandu/reports/latest/playwright-report.json" }],
    ["junit", { outputFile: "../../.mandu/reports/latest/junit.xml" }],
  ],
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  globalSetup: "./e2e/global-setup.mjs",
  use: { baseURL: "http://127.0.0.1:17318", trace: "off" },
  projects: [
    { name: "1920x1080", use: { viewport: { width: 1920, height: 1080 } } },
    { name: "1440x900", use: { viewport: { width: 1440, height: 900 } } },
    { name: "1366x768", use: { viewport: { width: 1366, height: 768 } } },
  ],
});

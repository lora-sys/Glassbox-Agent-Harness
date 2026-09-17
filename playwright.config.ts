import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  // The Glassbox server runs on 3030, the web dev server on 5173
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  // Start web dev server on port 4173
  webServer: {
    command: "npm run dev --workspace @glassbox/web -- --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: true,
  },
});

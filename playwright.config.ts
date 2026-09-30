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
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Start the web server at the same origin used by the specs and server CORS policy.
  webServer: {
    command: "npm run dev:web -- --host localhost --port 5173 --strictPort",
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
});

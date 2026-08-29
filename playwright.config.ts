import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
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
  // Expect the servers to already be running (server on 3030, web on 5173)
  webServer: {
    command: "echo 'assuming servers already running on 3030 and 5173'",
    port: 5173,
    reuseExistingServer: true,
  },
});

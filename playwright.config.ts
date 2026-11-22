import { defineConfig, devices } from "@playwright/test";
import { readTestRun } from "./scripts/postgres-test-guard.mjs";

const run = readTestRun(process.env, ["e2e", "e2e-pending"]);
const port = Number(process.env.E2E_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT no es válido.");
const baseURL = `http://127.0.0.1:${port}`;
const pendingScenario = /shows a pending cancellation/;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 1,
  ...(run.purpose === "e2e-pending" ? { grep: pendingScenario } : { grepInvert: pendingScenario }),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/start-test-web.mjs",
    port,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

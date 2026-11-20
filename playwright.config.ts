import { defineConfig, devices } from "@playwright/test";
import { parseAndValidateTestDatabaseUrl } from "./src/test-support/postgres-test-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) parseAndValidateTestDatabaseUrl(testDatabaseUrl);
const host = testDatabaseUrl ? "127.0.0.1" : "localhost";
const port = Number(process.env.E2E_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid E2E_PORT.");
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
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
    command: testDatabaseUrl ? `npm run dev -- --webpack --hostname ${host} --port ${port}` : `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !testDatabaseUrl && !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: testDatabaseUrl ?? "postgresql://postgres:postgres@localhost:5432/fullstack_nextjs",
    },
  },
});

import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test-support/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: [process.env.POSTGRES_TEST_SCOPE === "integration" ? "src/**/*.integration.test.ts" : "src/**/*.test.ts"],
    passWithNoTests: false,
  },
});

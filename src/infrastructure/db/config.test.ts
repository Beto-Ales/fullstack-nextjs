import { describe, expect, it } from "vitest";

import { buildDatabaseConfig } from "@/src/infrastructure/db/config";

describe("buildDatabaseConfig", () => {
  it("builds a stable default pool configuration", () => {
    const config = buildDatabaseConfig({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/fullstack_nextjs",
    });

    expect(config.connectionString).toContain("postgresql://");
    expect(config.max).toBe(10);
    expect(config.idleTimeoutMillis).toBe(30_000);
  });
});


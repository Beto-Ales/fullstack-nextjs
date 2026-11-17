import { describe, expect, it } from "vitest";

import { parseEnvironment } from "@/src/infrastructure/env";

describe("parseEnvironment", () => {
  it("parses valid environment values", () => {
    const parsed = parseEnvironment({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/fullstack_nextjs",
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
      APP_TIME_ZONE: "Europe/Copenhagen",
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: "7",
      AUTH_RATE_LIMIT_WINDOW_MINUTES: "30",
    });

    expect(parsed.NODE_ENV).toBe("test");
    expect(parsed.LOG_LEVEL).toBe("warn");
    expect(parsed.APP_TIME_ZONE).toBe("Europe/Copenhagen");
    expect(parsed.AUTH_RATE_LIMIT_MAX_ATTEMPTS).toBe(7);
    expect(parsed.AUTH_RATE_LIMIT_WINDOW_MINUTES).toBe(30);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() =>
      parseEnvironment({
        APP_TIME_ZONE: "Europe/Copenhagen",
        LOG_LEVEL: "info",
        NODE_ENV: "test",
      }),
    ).toThrowError();
  });
});

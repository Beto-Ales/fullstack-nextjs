import { describe, expect, it } from "vitest";

import { LOGIN_GLOBAL_MAX_ATTEMPTS, parseEnvironment, parseLoginRateLimitConfig } from "@/src/infrastructure/env";

describe("parseEnvironment", () => {
  it("parses valid environment values", () => {
    const parsed = parseEnvironment({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/fullstack_nextjs",
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
      APP_TIME_ZONE: "Europe/Copenhagen",
    });

    expect(parsed.NODE_ENV).toBe("test");
    expect(parsed.LOG_LEVEL).toBe("warn");
    expect(parsed.APP_TIME_ZONE).toBe("Europe/Copenhagen");
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

describe("login rate limit configuration", () => {
  const secret = "ab".repeat(32);

  it("preserves the default threshold and window with a higher shared budget", () => {
    expect(parseLoginRateLimitConfig({ AUTH_RATE_LIMIT_HMAC_KEY: secret })).toEqual({
      AUTH_RATE_LIMIT_HMAC_KEY: secret,
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: 5,
      AUTH_RATE_LIMIT_WINDOW_MINUTES: 15,
    });
    expect(LOGIN_GLOBAL_MAX_ATTEMPTS).toBe(600);
  });

  it("accepts shared overrides within the configured bounds", () => {
    expect(parseLoginRateLimitConfig({
      AUTH_RATE_LIMIT_HMAC_KEY: secret,
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: "100",
      AUTH_RATE_LIMIT_WINDOW_MINUTES: "60",
    })).toMatchObject({ AUTH_RATE_LIMIT_MAX_ATTEMPTS: 100, AUTH_RATE_LIMIT_WINDOW_MINUTES: 60 });
  });

  it.each([
    ["AUTH_RATE_LIMIT_HMAC_KEY", undefined],
    ["AUTH_RATE_LIMIT_HMAC_KEY", "zz".repeat(32)],
    ["AUTH_RATE_LIMIT_HMAC_KEY", "ab".repeat(31)],
    ["AUTH_RATE_LIMIT_MAX_ATTEMPTS", "0"],
    ["AUTH_RATE_LIMIT_MAX_ATTEMPTS", "1.5"],
    ["AUTH_RATE_LIMIT_MAX_ATTEMPTS", "101"],
    ["AUTH_RATE_LIMIT_WINDOW_MINUTES", ""],
    ["AUTH_RATE_LIMIT_WINDOW_MINUTES", "-1"],
    ["AUTH_RATE_LIMIT_WINDOW_MINUTES", "61"],
  ])("rejects invalid %s values", (key, value) => {
    expect(() => parseLoginRateLimitConfig({ AUTH_RATE_LIMIT_HMAC_KEY: secret, [key]: value })).toThrow();
  });

  it("keeps invalid login policy separate from database and session configuration", () => {
    expect(parseEnvironment({
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      AUTH_RATE_LIMIT_HMAC_KEY: "invalid",
      AUTH_RATE_LIMIT_MAX_ATTEMPTS: "-1",
    }).NODE_ENV).toBe("development");
  });
});

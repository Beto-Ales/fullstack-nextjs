import { beforeEach, describe, expect, it } from "vitest";

import { buildRateLimitKey, clearLoginFailures, isLoginBlocked, registerLoginFailure } from "@/src/infrastructure/security/auth-rate-limit";

describe("auth rate limit", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/fullstack_nextjs";
    process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = "2";
    process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES = "1";
  });

  it("blocks after configured number of failures", () => {
    const key = buildRateLimitKey("test@example.com", "source");

    registerLoginFailure(key);
    expect(isLoginBlocked(key)).toBe(false);

    registerLoginFailure(key);
    expect(isLoginBlocked(key)).toBe(true);

    clearLoginFailures(key);
    expect(isLoginBlocked(key)).toBe(false);
  });
});


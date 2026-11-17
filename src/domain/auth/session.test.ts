import { describe, expect, it } from "vitest";

import { isSessionExpired } from "@/src/domain/auth/session";

describe("isSessionExpired", () => {
  it("detects active and expired sessions", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(isSessionExpired(new Date("2026-01-01T00:00:01.000Z"), now)).toBe(false);
    expect(isSessionExpired(new Date("2025-12-31T23:59:59.000Z"), now)).toBe(true);
  });
});


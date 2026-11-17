import { describe, expect, it } from "vitest";

import { createSessionToken, hashSessionToken } from "@/src/infrastructure/security/session-token";

describe("session token", () => {
  it("creates random tokens and stable hashes", () => {
    const tokenA = createSessionToken();
    const tokenB = createSessionToken();

    expect(tokenA).not.toBe(tokenB);
    expect(hashSessionToken(tokenA)).toBe(hashSessionToken(tokenA));
    expect(hashSessionToken(tokenA)).not.toBe(hashSessionToken(tokenB));
  });
});


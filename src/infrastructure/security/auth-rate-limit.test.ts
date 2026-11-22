import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildLoginBudgetKey } from "@/src/infrastructure/security/auth-rate-limit";

describe("login budget identity", () => {
  const secret = "af".repeat(32);

  it("derives a stable HMAC over the normalized email", () => {
    const email = "test@example.com";
    const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(`login:${email}`).digest("hex");
    const key = buildLoginBudgetKey(" Te st@Example.COM ", secret);

    expect(key).toBe(expected);
    expect(buildLoginBudgetKey(email, secret.toUpperCase())).toBe(key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain(email);
  });

  it("separates identities and secrets", () => {
    const key = buildLoginBudgetKey("test@example.com", secret);
    expect(buildLoginBudgetKey("other@example.com", secret)).not.toBe(key);
    expect(buildLoginBudgetKey("test@example.com", "fa".repeat(32))).not.toBe(key);
  });
});

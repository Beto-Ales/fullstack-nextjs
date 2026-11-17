import { describe, expect, it } from "vitest";

import { loginInputSchema } from "@/src/application/auth/schemas";

describe("loginInputSchema", () => {
  it("normalizes valid login input", () => {
    const parsed = loginInputSchema.parse({
      email: "  TeSt@Example.com ",
      password: "1234567890AB",
    });

    expect(parsed.email).toBe("test@example.com");
    expect(parsed.password).toBe("1234567890AB");
  });

  it("rejects short passwords", () => {
    expect(() =>
      loginInputSchema.parse({
        email: "test@example.com",
        password: "short",
      }),
    ).toThrowError();
  });
});


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

  it.each([
    { email: "test@example.com".padStart(1025), password: "existing-password" },
    { email: "test@example", password: "existing-password" },
    { email: "test@example.com", password: "x".repeat(129) },
  ])("rejects oversized or malformed credentials", (input) => {
    expect(loginInputSchema.safeParse(input).success).toBe(false);
  });

  it("preserves the login format used by existing bcrypt passwords", () => {
    const password = "  " + "ø".repeat(40);
    expect(loginInputSchema.parse({ email: "test@example.com", password }).password).toBe(password);
  });
});


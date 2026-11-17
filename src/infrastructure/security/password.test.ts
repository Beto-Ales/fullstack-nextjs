import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/src/infrastructure/security/password";

describe("password hashing", () => {
  it("hashes and verifies password", async () => {
    const plain = "1234567890AB";
    const hash = await hashPassword(plain);

    expect(hash).not.toBe(plain);
    await expect(verifyPassword(plain, hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });
});


import { describe, expect, it } from "vitest";

import { normalizeEmail } from "@/src/domain/auth/email";

describe("normalizeEmail", () => {
  it("normalizes spaces and casing", () => {
    expect(normalizeEmail("  UsEr @Example.COM ")).toBe("user@example.com");
  });
});


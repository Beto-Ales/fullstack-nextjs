import { describe, expect, it } from "vitest";

import { hasRequiredRole } from "@/src/domain/auth/authorization";

describe("hasRequiredRole", () => {
  it("allows same role and denies different role", () => {
    expect(hasRequiredRole("SUPER_ADMIN", "SUPER_ADMIN")).toBe(true);
    expect(hasRequiredRole("STUDENT", "SUPER_ADMIN")).toBe(false);
  });
});


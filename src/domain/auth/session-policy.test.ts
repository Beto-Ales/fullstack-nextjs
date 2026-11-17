import { describe, expect, it } from "vitest";

import { getSessionCookieName } from "@/src/domain/auth/session-policy";

describe("getSessionCookieName", () => {
  it("uses __Host- prefix in production", () => {
    expect(getSessionCookieName("production")).toBe("__Host-artwork_session");
  });

  it("uses local cookie name outside production", () => {
    expect(getSessionCookieName("development")).toBe("artwork_session");
  });
});


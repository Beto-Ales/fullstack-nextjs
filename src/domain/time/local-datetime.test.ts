import { describe, expect, it } from "vitest";

import { resolveLocalDateTime } from "@/src/domain/time/local-datetime";

describe("resolveLocalDateTime", () => {
  it("keeps local recurring times stable in Europe/Copenhagen", () => {
    const winter = resolveLocalDateTime({
      localDate: "2026-01-20",
      localTime: "18:00",
    });
    const summer = resolveLocalDateTime({
      localDate: "2026-07-21",
      localTime: "18:00",
    });

    expect(winter.toFormat("HH:mm")).toBe("18:00");
    expect(summer.toFormat("HH:mm")).toBe("18:00");
  });

  it("resolves non-existent local hour during DST jump deterministically", () => {
    const resolved = resolveLocalDateTime({
      localDate: "2026-03-29",
      localTime: "02:30",
    });
    expect(resolved.isValid).toBe(true);
    expect(resolved.toFormat("HH:mm")).toBe("03:30");
  });
});

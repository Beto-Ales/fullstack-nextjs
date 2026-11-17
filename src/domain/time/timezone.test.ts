import { describe, expect, it } from "vitest";

import { CENTER_TIME_ZONE, formatInCenterTimeZone, isCenterTimeZone } from "@/src/domain/time/timezone";

describe("timezone helpers", () => {
  it("keeps Europe/Copenhagen as center time zone", () => {
    expect(CENTER_TIME_ZONE).toBe("Europe/Copenhagen");
    expect(isCenterTimeZone("Europe/Copenhagen")).toBe(true);
    expect(isCenterTimeZone("UTC")).toBe(false);
  });

  it("formats dates using center time zone", () => {
    const output = formatInCenterTimeZone(new Date("2026-01-15T10:00:00.000Z"), "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    expect(output).toBe("11:00");
  });
});


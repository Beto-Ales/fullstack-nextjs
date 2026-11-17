import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";

import { generateRecurringSessionCandidates } from "@/src/domain/academic/recurrence";

const template = {
  id: "template-1",
  isoWeekday: 2,
  startsAtLocalTime: "18:00:00",
  durationMinutes: 60,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  maxCapacity: 12,
};

describe("generateRecurringSessionCandidates", () => {
  it("generates only occurrences inside horizon and matching weekday", () => {
    const now = DateTime.fromISO("2026-01-05T10:00:00", { zone: "Europe/Copenhagen" }); // Monday
    const horizonEnd = DateTime.fromISO("2026-01-31T23:59:59", { zone: "Europe/Copenhagen" });

    const candidates = generateRecurringSessionCandidates(template, { now, horizonEnd });
    expect(candidates.length).toBe(4);
    expect(candidates.every((candidate) => candidate.templateId === "template-1")).toBe(true);
  });

  it("is deterministic and idempotent for the same input window", () => {
    const now = DateTime.fromISO("2026-02-01T10:00:00", { zone: "Europe/Copenhagen" });
    const horizonEnd = DateTime.fromISO("2026-02-28T23:59:59", { zone: "Europe/Copenhagen" });

    const first = generateRecurringSessionCandidates(template, { now, horizonEnd });
    const second = generateRecurringSessionCandidates(template, { now, horizonEnd });

    expect(first).toEqual(second);
  });

  it("respects template effective end date", () => {
    const now = DateTime.fromISO("2026-01-01T10:00:00", { zone: "Europe/Copenhagen" });
    const horizonEnd = DateTime.fromISO("2026-03-01T23:59:59", { zone: "Europe/Copenhagen" });

    const endingTemplate = {
      ...template,
      effectiveTo: "2026-01-20",
    };

    const candidates = generateRecurringSessionCandidates(endingTemplate, { now, horizonEnd });
    expect(candidates.every((candidate) => candidate.localDate <= "2026-01-20")).toBe(true);
  });
});


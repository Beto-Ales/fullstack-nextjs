import { describe, expect, it } from "vitest";

import { classifyCancellationTiming, evaluateCancellationSequence, type HabitualSequenceEvent } from "@/src/domain/academic/cancellation-rules";

describe("classifyCancellationTiming", () => {
  it("classifies exact 7-day cancellation as ON_TIME", () => {
    const start = new Date("2026-04-14T16:00:00.000Z");
    const cancel = new Date("2026-04-07T16:00:00.000Z");

    const result = classifyCancellationTiming(cancel, start);
    expect(result.type).toBe("ON_TIME");
    expect(result.meetsSevenDayRule).toBe(true);
  });

  it("classifies cancellation under 7 days as LATE", () => {
    const start = new Date("2026-04-14T16:00:00.000Z");
    const cancel = new Date("2026-04-08T16:01:00.000Z");

    const result = classifyCancellationTiming(cancel, start);
    expect(result.type).toBe("LATE");
    expect(result.meetsSevenDayRule).toBe(false);
  });
});

describe("evaluateCancellationSequence", () => {
  function cancellation(id: string, when: string, type: "ON_TIME" | "LATE", habitual = true): HabitualSequenceEvent {
    return {
      eventType: "CANCELLATION",
      id,
      startsAtUtc: new Date(when),
      meetsSevenDayRule: type === "ON_TIME",
      cancellationType: type,
      isHabitualReservation: habitual,
    };
  }

  function attendance(id: string, when: string, outcome: "ATTENDED" | "ABSENT", habitual = true): HabitualSequenceEvent {
    return {
      eventType: "ATTENDANCE",
      id,
      startsAtUtc: new Date(when),
      outcome,
      isHabitualReservation: habitual,
    };
  }

  it("marks third ON_TIME cancellation as credit candidate and fourth as non-candidate", () => {
    const results = evaluateCancellationSequence([
      cancellation("c1", "2026-01-01T10:00:00.000Z", "ON_TIME"),
      cancellation("c2", "2026-01-08T10:00:00.000Z", "ON_TIME"),
      cancellation("c3", "2026-01-15T10:00:00.000Z", "ON_TIME"),
      cancellation("c4", "2026-01-22T10:00:00.000Z", "ON_TIME"),
    ]);

    expect(results.find((item) => item.id === "c3")?.canGenerateCreditCandidate).toBe(true);
    expect(results.find((item) => item.id === "c4")?.canGenerateCreditCandidate).toBe(false);
  });

  it("does not mark third LATE cancellation as credit candidate", () => {
    const results = evaluateCancellationSequence([
      cancellation("c1", "2026-01-01T10:00:00.000Z", "ON_TIME"),
      cancellation("c2", "2026-01-08T10:00:00.000Z", "LATE"),
      cancellation("c3", "2026-01-15T10:00:00.000Z", "LATE"),
    ]);

    expect(results.find((item) => item.id === "c3")?.canGenerateCreditCandidate).toBe(false);
    expect(results.find((item) => item.id === "c3")?.nonEligibilityReason).toBe("TIMING");
  });

  it("resets sequence after ATTENDED and ABSENT", () => {
    const results = evaluateCancellationSequence([
      cancellation("c1", "2026-01-01T10:00:00.000Z", "ON_TIME"),
      cancellation("c2", "2026-01-08T10:00:00.000Z", "ON_TIME"),
      attendance("a1", "2026-01-10T10:00:00.000Z", "ATTENDED"),
      cancellation("c3", "2026-01-15T10:00:00.000Z", "ON_TIME"),
      attendance("a2", "2026-01-20T10:00:00.000Z", "ABSENT"),
      cancellation("c4", "2026-01-22T10:00:00.000Z", "ON_TIME"),
    ]);

    expect(results.find((item) => item.id === "c3")?.sequencePosition).toBe(1);
    expect(results.find((item) => item.id === "c4")?.sequencePosition).toBe(1);
  });

  it("ignores non-habitual cancellations for habitual sequence", () => {
    const results = evaluateCancellationSequence([
      cancellation("c1", "2026-01-01T10:00:00.000Z", "ON_TIME"),
      cancellation("c2", "2026-01-08T10:00:00.000Z", "ON_TIME", false),
      cancellation("c3", "2026-01-15T10:00:00.000Z", "ON_TIME"),
      cancellation("c4", "2026-01-22T10:00:00.000Z", "ON_TIME"),
    ]);

    expect(results.find((item) => item.id === "c2")?.nonEligibilityReason).toBe("NON_HABITUAL");
    expect(results.find((item) => item.id === "c4")?.sequencePosition).toBe(3);
    expect(results.find((item) => item.id === "c4")?.canGenerateCreditCandidate).toBe(true);
  });
});


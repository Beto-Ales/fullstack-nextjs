import { describe, expect, it } from "vitest";

import { classifyCancellationTiming, evaluateCancellationSequence, evaluateCancellationTimeline, type HabitualSequenceEvent } from "@/src/domain/academic/cancellation-rules";

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

  it("counts Copenhagen calendar dates across the daylight-saving change", () => {
    const start = new Date("2026-04-04T06:00:00.000Z");
    const beforeMidnight = new Date("2026-03-28T22:59:00.000Z");
    const midnight = new Date("2026-03-28T23:00:00.000Z");

    expect(classifyCancellationTiming(beforeMidnight, start).type).toBe("ON_TIME");
    expect(classifyCancellationTiming(midnight, start).type).toBe("LATE");
    expect(classifyCancellationTiming(beforeMidnight, start, 8).type).toBe("LATE");
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

  it("preserves the legacy third-position eligibility while that rule is in effect", () => {
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

  it("preserves the legacy attendance reset while that rule is in effect", () => {
    const results = evaluateCancellationSequence([
      cancellation("c1", "2026-01-01T10:00:00.000Z", "ON_TIME"),
      cancellation("c2", "2026-01-08T10:00:00.000Z", "ON_TIME"),
      attendance("a1", "2026-01-10T10:00:00.000Z", "ATTENDED"),
      cancellation("c3", "2026-01-15T10:00:00.000Z", "ON_TIME"),
      attendance("a2", "2026-01-20T10:00:00.000Z", "ABSENT"),
      cancellation("c4", "2026-01-22T10:00:00.000Z", "ON_TIME"),
    ]);

    expect(results.find((item) => item.id === "c3")?.sequencePosition).toBe(1);
    expect(results.find((item) => item.id === "c4")?.sequencePosition).toBe(2);
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

  describe("configurable rule for known outcomes", () => {
    const rules = { maxEligibleConsecutiveCancellations: 3 };

    it("allows the first three and counts the fourth and fifth without eligibility across different weekdays", () => {
      const events = [
        cancellation("c1", "2026-01-01T10:00:00.000Z", "ON_TIME"),
        cancellation("c2", "2026-01-03T10:00:00.000Z", "ON_TIME"),
        cancellation("c3", "2026-01-06T10:00:00.000Z", "ON_TIME"),
        cancellation("c4", "2026-01-08T10:00:00.000Z", "ON_TIME"),
        cancellation("c5", "2026-01-09T10:00:00.000Z", "ON_TIME"),
      ];
      const results = evaluateCancellationSequence([...events].reverse(), rules);
      expect(results.map(({ id, sequencePosition, canGenerateCreditCandidate, nonEligibilityReason }) =>
        [id, sequencePosition, canGenerateCreditCandidate, nonEligibilityReason])).toEqual([
        ["c1", 1, true, null], ["c2", 2, true, null], ["c3", 3, true, null],
        ["c4", 4, false, "SEQUENCE_POSITION"], ["c5", 5, false, "SEQUENCE_POSITION"],
      ]);
      const lowLimit = evaluateCancellationSequence(events, { maxEligibleConsecutiveCancellations: 1 });
      expect(lowLimit.filter(({ canGenerateCreditCandidate }) => canGenerateCreditCandidate)).toHaveLength(1);
      expect(lowLimit[2]).toMatchObject({ isThirdCancellation: true, canGenerateCreditCandidate: false });
    });

    it("counts a late cancellation and resets after either habitual attendance outcome", () => {
      const results = evaluateCancellationSequence([
        cancellation("c1", "2026-01-01T10:00:00.000Z", "LATE"),
        attendance("nonHabitual", "2026-01-02T10:00:00.000Z", "ATTENDED", false),
        cancellation("c2", "2026-01-03T10:00:00.000Z", "ON_TIME"),
        attendance("a1", "2026-01-06T10:00:00.000Z", "ATTENDED"),
        cancellation("c3", "2026-01-08T10:00:00.000Z", "ON_TIME"),
        cancellation("ordinary", "2026-01-09T10:00:00.000Z", "ON_TIME", false),
        attendance("a2", "2026-01-10T10:00:00.000Z", "ABSENT"),
        cancellation("c4", "2026-01-11T10:00:00.000Z", "ON_TIME"),
      ], rules);
      expect(results.map(({ id, sequencePosition, canGenerateCreditCandidate, nonEligibilityReason }) =>
        [id, sequencePosition, canGenerateCreditCandidate, nonEligibilityReason])).toEqual([
        ["c1", 1, false, "TIMING"], ["c2", 2, true, null], ["c3", 1, true, null],
        ["ordinary", null, false, "NON_HABITUAL"], ["c4", 1, true, null],
      ]);
      expect(new Set(results.filter(({ sequenceId }) => sequenceId).map(({ sequenceId }) => sequenceId)).size).toBe(3);
    });

    it("breaks exact time ties deterministically and requires reliable evidence of notice", () => {
      const sameStart = "2026-01-01T10:00:00.000Z";
      const incomplete = { ...cancellation("b", sameStart, "ON_TIME"), meetsSevenDayRule: false };
      const results = evaluateCancellationSequence([
        incomplete,
        cancellation("a", sameStart, "ON_TIME"),
      ], rules);
      expect(results).toMatchObject([
        { id: "a", sequencePosition: 1, canGenerateCreditCandidate: true },
        { id: "b", sequencePosition: 2, canGenerateCreditCandidate: false, nonEligibilityReason: "TIMING" },
      ]);
    });

    it("holds a position when an earlier class is unresolved and resumes at a recorded reset", () => {
      const unresolved: HabitualSequenceEvent = {
        eventType: "PENDING", id: "p", startsAtUtc: new Date("2026-01-02T10:00:00Z"), isHabitualReservation: true,
      };
      const result = evaluateCancellationTimeline([
        cancellation("c1", "2026-01-01T10:00:00Z", "ON_TIME"),
        unresolved,
        cancellation("c2", "2026-01-03T10:00:00Z", "ON_TIME"),
        attendance("a", "2026-01-04T10:00:00Z", "ABSENT"),
        cancellation("c3", "2026-01-06T10:00:00Z", "ON_TIME"),
      ], rules);
      expect(result.cancellations).toMatchObject([
        { id: "c1", sequencePosition: 1, sequencePending: false },
        { id: "c2", sequencePosition: null, sequencePending: true, canGenerateCreditCandidate: false },
        { id: "c3", sequencePosition: 1, sequencePending: false, canGenerateCreditCandidate: true },
      ]);
      expect(result.currentIsProvisional).toBe(false);
    });

    it("counts the same habitual session once even if its seat was booked again", () => {
      const startedAt = "2026-01-01T10:00:00Z";
      const result = evaluateCancellationSequence([
        { ...cancellation("c1", startedAt, "ON_TIME"), sessionId: "s1" },
        { ...cancellation("c2", startedAt, "ON_TIME"), sessionId: "s1" },
        { ...cancellation("c3", "2026-01-02T10:00:00Z", "ON_TIME"), sessionId: "s2" },
      ], rules);
      expect(result.map(({ sequencePosition }) => sequencePosition)).toEqual([1, 1, 2]);
    });
  });
});


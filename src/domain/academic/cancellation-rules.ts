import { DateTime } from "luxon";

import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";

export type CancellationTimingType = "ON_TIME" | "LATE";
export type CancellationEligibilityReason = "TIMING" | "SEQUENCE_POSITION" | "NON_HABITUAL";

export function classifyCancellationTiming(
  cancelledAtUtc: Date,
  classStartsAtUtc: Date,
  noticeDays = INITIAL_REGULATION.cancellationNoticeDays,
): {
  type: CancellationTimingType;
  meetsSevenDayRule: boolean;
  hoursBeforeStart: number;
} {
  const cancelledAt = DateTime.fromJSDate(cancelledAtUtc, { zone: "utc" }).setZone(CENTER_TIME_ZONE);
  const classStartsAt = DateTime.fromJSDate(classStartsAtUtc, { zone: "utc" }).setZone(CENTER_TIME_ZONE);
  const diffHours = classStartsAt.diff(cancelledAt, "hours").hours;
  const noticeDeadline = classStartsAt.startOf("day").minus({ days: noticeDays });
  const meetsSevenDayRule = cancelledAt.startOf("day") <= noticeDeadline && cancelledAt <= classStartsAt;

  return {
    type: meetsSevenDayRule ? "ON_TIME" : "LATE",
    meetsSevenDayRule,
    hoursBeforeStart: Math.floor(diffHours),
  };
}

export type HabitualSequenceEvent = { sessionId?: string } & (
  | {
      eventType: "CANCELLATION";
      id: string;
      startsAtUtc: Date;
      meetsSevenDayRule: boolean;
      cancellationType: CancellationTimingType;
      maxEligibleConsecutiveCancellations?: number;
      isHabitualReservation: boolean;
    }
  | {
      eventType: "ATTENDANCE";
      id: string;
      startsAtUtc: Date;
      outcome: "ATTENDED" | "ABSENT";
      isHabitualReservation: boolean;
    }
  | { eventType: "PENDING"; id: string; startsAtUtc: Date; isHabitualReservation: true }
);

export type EvaluatedCancellation = {
  id: string;
  sequenceId: string | null;
  sequencePosition: number | null;
  isThirdCancellation: boolean;
  canGenerateCreditCandidate: boolean;
  nonEligibilityReason: CancellationEligibilityReason | null;
  sequencePending: boolean;
};

export function evaluateCancellationSequence(
  events: HabitualSequenceEvent[],
  rules?: { maxEligibleConsecutiveCancellations: number },
): EvaluatedCancellation[] {
  return evaluateCancellationTimeline(events, rules).cancellations;
}

export function evaluateCancellationTimeline(
  events: HabitualSequenceEvent[],
  rules?: { maxEligibleConsecutiveCancellations: number },
) {
  // The existing rule remains available for operations tied to a legacy policy.
  const sorted = [...events].sort((a, b) => {
    const byStart = a.startsAtUtc.getTime() - b.startsAtUtc.getTime();
    if (byStart || !rules) return byStart;
    const sessionA = a.sessionId ?? a.id;
    const sessionB = b.sessionId ?? b.id;
    if (sessionA !== sessionB) return sessionA < sessionB ? -1 : 1;
    if (a.sessionId && a.sessionId === b.sessionId && a.eventType !== b.eventType) {
      // A recorded result after a re-enrollment describes the same session, not an earlier one.
      if (a.eventType === "CANCELLATION") return -1;
      if (b.eventType === "CANCELLATION") return 1;
    }
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.eventType.localeCompare(b.eventType);
  });
  let sequenceCounter = 0;
  let sequenceIdSeed = 0;
  let currentSequenceId: string | null = null;
  let unresolvedPredecessor = false;
  let currentIsProvisional = false;
  const countedSessions = new Set<string>();

  const evaluated: EvaluatedCancellation[] = [];

  for (const event of sorted) {
    if (!event.isHabitualReservation) {
      if (event.eventType === "CANCELLATION") {
        evaluated.push({
          id: event.id,
          sequenceId: null,
          sequencePosition: null,
          isThirdCancellation: false,
          canGenerateCreditCandidate: false,
          nonEligibilityReason: "NON_HABITUAL",
          sequencePending: false,
        });
      }
      continue;
    }

    if (event.eventType === "PENDING") {
      if (rules) unresolvedPredecessor = true;
      continue;
    }

    if (event.eventType === "ATTENDANCE") {
      if (rules || event.outcome === "ATTENDED") {
        sequenceCounter = 0;
        currentSequenceId = null;
        unresolvedPredecessor = false;
        currentIsProvisional = false;
      }
      continue;
    }

    if (!currentSequenceId) {
      sequenceIdSeed += 1;
      currentSequenceId = `seq-${sequenceIdSeed}`;
    }
    if (!rules || !event.sessionId || !countedSessions.has(event.sessionId)) {
      sequenceCounter += 1;
      if (event.sessionId) countedSessions.add(event.sessionId);
    }
    currentIsProvisional = unresolvedPredecessor;

    const isThird = sequenceCounter === 3;
    const eligiblePosition = rules
      ? sequenceCounter <= (event.maxEligibleConsecutiveCancellations ?? rules.maxEligibleConsecutiveCancellations)
      : isThird;
    const onTime = event.cancellationType === "ON_TIME" && (!rules || event.meetsSevenDayRule);
    const canGenerateCreditCandidate = eligiblePosition && onTime;

    let nonEligibilityReason: CancellationEligibilityReason | null = null;
    if (!canGenerateCreditCandidate) {
      if (!eligiblePosition) {
        nonEligibilityReason = "SEQUENCE_POSITION";
      } else if (rules || !event.meetsSevenDayRule) {
        nonEligibilityReason = "TIMING";
      }
    }

    evaluated.push({
      id: event.id,
      sequenceId: currentSequenceId,
      sequencePosition: unresolvedPredecessor ? null : sequenceCounter,
      isThirdCancellation: !unresolvedPredecessor && isThird,
      canGenerateCreditCandidate: !unresolvedPredecessor && canGenerateCreditCandidate,
      nonEligibilityReason: unresolvedPredecessor ? null : nonEligibilityReason,
      sequencePending: unresolvedPredecessor,
    });
  }

  return {
    cancellations: evaluated,
    currentConsecutiveCancellations: sequenceCounter,
    currentIsProvisional,
    unresolvedPredecessor,
  };
}


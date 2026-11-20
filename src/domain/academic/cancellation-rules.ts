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

export type HabitualSequenceEvent =
  | {
      eventType: "CANCELLATION";
      id: string;
      startsAtUtc: Date;
      meetsSevenDayRule: boolean;
      cancellationType: CancellationTimingType;
      isHabitualReservation: boolean;
    }
  | {
      eventType: "ATTENDANCE";
      id: string;
      startsAtUtc: Date;
      outcome: "ATTENDED" | "ABSENT";
      isHabitualReservation: boolean;
    };

export type EvaluatedCancellation = {
  id: string;
  sequenceId: string | null;
  sequencePosition: number | null;
  isThirdCancellation: boolean;
  canGenerateCreditCandidate: boolean;
  nonEligibilityReason: CancellationEligibilityReason | null;
};

export function evaluateCancellationSequence(events: HabitualSequenceEvent[]): EvaluatedCancellation[] {
  const sorted = [...events].sort((a, b) => a.startsAtUtc.getTime() - b.startsAtUtc.getTime());
  let sequenceCounter = 0;
  let sequenceIdSeed = 0;
  let currentSequenceId: string | null = null;

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
        });
      }
      continue;
    }

    if (event.eventType === "ATTENDANCE") {
      if (event.outcome === "ATTENDED") {
        sequenceCounter = 0;
        currentSequenceId = null;
      }
      continue;
    }

    if (!currentSequenceId) {
      sequenceIdSeed += 1;
      currentSequenceId = `seq-${sequenceIdSeed}`;
    }
    sequenceCounter += 1;

    const isThird = sequenceCounter === 3;
    const canGenerateCreditCandidate = isThird && event.cancellationType === "ON_TIME";

    let nonEligibilityReason: CancellationEligibilityReason | null = null;
    if (!canGenerateCreditCandidate) {
      if (!isThird) {
        nonEligibilityReason = "SEQUENCE_POSITION";
      } else if (!event.meetsSevenDayRule) {
        nonEligibilityReason = "TIMING";
      }
    }

    evaluated.push({
      id: event.id,
      sequenceId: currentSequenceId,
      sequencePosition: sequenceCounter,
      isThirdCancellation: isThird,
      canGenerateCreditCandidate,
      nonEligibilityReason,
    });
  }

  return evaluated;
}


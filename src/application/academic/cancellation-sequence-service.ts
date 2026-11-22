import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { currentClassAttendance, reservationHasHabitualAssignment } from "@/src/application/academic/student-class-queries";
import type { TransactionClient, tryGenerateAutoCreditFromCancellation } from "@/src/application/credits/credit-service";
import { evaluateCancellationTimeline, type HabitualSequenceEvent } from "@/src/domain/academic/cancellation-rules";
import { INITIAL_CONSECUTIVE_CANCELLATIONS_LIMIT } from "@/src/domain/academic/regulation";
import { regulationDate } from "@/src/application/academic/regulation-service";
import {
  academicRegulations, classReservations, classSessions, creditLedgerMovements,
  reservationAttendanceRecords, reservationCancellations, studentProfiles,
} from "@/src/infrastructure/db/schema";

type SequenceReader = Pick<TransactionClient, "select">;
type GrantResult = Awaited<ReturnType<typeof tryGenerateAutoCreditFromCancellation>>;

async function readHabitualResults(reader: SequenceReader, studentProfileId: string) {
  return reader.select({
    reservationId: classReservations.id,
    sessionId: classSessions.id,
    startsAtUtc: classSessions.startsAtUtc,
    cancellationId: reservationCancellations.id,
    cancelledAt: reservationCancellations.cancelledAt,
    cancellationType: reservationCancellations.cancellationType,
    meetsNotice: reservationCancellations.meetsSevenDayRule,
    sequencePending: reservationCancellations.sequencePending,
    maxEligible: academicRegulations.maxEligibleConsecutiveCancellations,
    outcome: reservationAttendanceRecords.outcome,
  }).from(classReservations)
    .innerJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .leftJoin(reservationAttendanceRecords, currentClassAttendance)
    .leftJoin(academicRegulations, eq(academicRegulations.id, reservationCancellations.regulationVersionId))
    .where(and(eq(classReservations.studentProfileId, studentProfileId), eq(classReservations.origin, "ORDINARY"), sql`(
      (
        ${classReservations.status} = 'CANCELLED'
        and ${reservationCancellations.isHabitualReservation}
        and (
          ${reservationCancellations.decisionSource} = 'STUDENT_REQUEST'
          or (${reservationCancellations.decisionSource} is null
            and coalesce(${reservationCancellations.cancelledByUserId}, ${classReservations.cancelledByUserId}) = ${studentProfiles.userId})
        )
      ) or (
        ${classReservations.status} = 'CONFIRMED'
        and ${reservationCancellations.id} is null
        and ${classSessions.status} <> 'CANCELLED'
        and ${reservationHasHabitualAssignment}
      ))`));
}

type HabitualResult = Awaited<ReturnType<typeof readHabitualResults>>[number];

function evaluateResults(rows: HabitualResult[], maxEligibleConsecutiveCancellations: number) {
  const events = rows.map<HabitualSequenceEvent>((row) => {
    const session = { startsAtUtc: row.startsAtUtc, sessionId: row.sessionId, isHabitualReservation: true as const };
    if (row.cancellationId && row.cancellationType) {
      return {
        ...session, eventType: "CANCELLATION", id: row.cancellationId,
        cancellationType: row.cancellationType, meetsSevenDayRule: row.meetsNotice === true,
        maxEligibleConsecutiveCancellations: row.maxEligible ?? undefined,
      };
    }
    if (row.outcome) return { ...session, eventType: "ATTENDANCE", id: row.reservationId, outcome: row.outcome };
    return { ...session, eventType: "PENDING", id: row.reservationId };
  });
  return evaluateCancellationTimeline(events, { maxEligibleConsecutiveCancellations });
}

export async function readCancellationStreak(reader: SequenceReader, studentProfileId: string, maximum: number) {
  const rows = await readHabitualResults(reader, studentProfileId);
  const { currentConsecutiveCancellations, currentIsProvisional, unresolvedPredecessor } = evaluateResults(rows, maximum);
  return { currentConsecutiveCancellations, currentIsProvisional, unresolvedPredecessor,
    pendingCredits: rows.filter((row) => row.sequencePending && row.meetsNotice).length };
}

// The caller holds the profile lock. Both evaluation and ledger writes run in that transaction.
export async function settlePendingCancellations(
  tx: TransactionClient, studentProfileId: string, grant: typeof tryGenerateAutoCreditFromCancellation,
) {
  const results = new Map<string, GrantResult>();
  const [firstPending] = await tx.select({ id: reservationCancellations.id }).from(reservationCancellations)
    .where(and(eq(reservationCancellations.studentProfileId, studentProfileId), eq(reservationCancellations.sequencePending, true)))
    .limit(1);
  if (!firstPending) return results;
  const rows = await readHabitualResults(tx, studentProfileId);
  const { cancellations } = evaluateResults(rows, INITIAL_CONSECUTIVE_CANCELLATIONS_LIMIT);
  const decisions = new Map(cancellations.map((decision) => [decision.id, decision]));
  const requests = rows.flatMap((row) => row.sequencePending && row.cancellationId && row.cancelledAt && row.maxEligible !== null
    ? [{ ...row, cancellationId: row.cancellationId, cancelledAt: row.cancelledAt, maxEligible: row.maxEligible }] : []);
  requests.sort((a, b) => a.cancelledAt.getTime() - b.cancelledAt.getTime() || a.cancellationId.localeCompare(b.cancellationId));

  const grantedRows = await tx.select({ id: creditLedgerMovements.sourceCancellationId })
    .from(creditLedgerMovements)
    .where(and(
      eq(creditLedgerMovements.studentProfileId, studentProfileId),
      eq(creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
      inArray(creditLedgerMovements.sourceCancellationId, [...decisions.keys()]),
    ));
  const granted = new Set(grantedRows.map(({ id }) => id));
  const grantedSessions = new Set(rows.filter((row) => granted.has(row.cancellationId)).map(({ sessionId }) => sessionId));
  const waitingMonths = new Set<string>();
  for (const request of requests) {
    const decision = decisions.get(request.cancellationId);
    if (!decision) continue;
    const month = regulationDate(request.cancelledAt).slice(0, 7);
    if (decision.sequencePending) {
      if (request.meetsNotice && request.maxEligible > 0) waitingMonths.add(month);
      continue;
    }
    if (decision.canGenerateCreditCandidate && waitingMonths.has(month)) continue;

    // A later booking or rescheduling can change the observed positions. Preserve grants already made.
    const exhaustedSequence = decision.canGenerateCreditCandidate && (grantedSessions.has(request.sessionId)
      || cancellations.filter((item) => item.sequenceId === decision.sequenceId && granted.has(item.id)).length >= request.maxEligible);
    const { id, ...snapshot } = decision;
    await tx.update(reservationCancellations).set({
      ...snapshot,
      canGenerateCreditCandidate: decision.canGenerateCreditCandidate && !exhaustedSequence,
      nonEligibilityReason: exhaustedSequence ? "SEQUENCE_POSITION" : decision.nonEligibilityReason,
      updatedAt: new Date(),
    }).where(eq(reservationCancellations.id, id));
    const result = await grant(tx, id);
    await tx.update(reservationCancellations).set({
      creditResolution: result.created || result.reason === "IDEMPOTENT_ALREADY_EXISTS" ? "GRANTED"
        : result.reason === "MONTHLY_LIMIT" ? "MONTHLY_LIMIT" : "NOT_ELIGIBLE",
    }).where(eq(reservationCancellations.id, id));
    results.set(id, result);
    if (result.created) {
      granted.add(id);
      grantedSessions.add(request.sessionId);
    }
  }
  return results;
}

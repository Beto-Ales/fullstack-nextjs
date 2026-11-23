import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";

import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { cancelFutureAssignmentSchema } from "@/src/application/academic/schemas";
import { requireActiveStudentForBooking } from "@/src/application/auth/active-student";
import { lockStudentProfile } from "@/src/application/credits/credit-service";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import { lockTemplateAssignments } from "@/src/infrastructure/db/habitual-reservations.mjs";
import {
  classReservations,
  classSessions,
  studentTemplateAssignmentCancellations,
  studentTemplateAssignments,
} from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

export const WITHDRAWAL_ASSIGNMENT_CANCELLATION_REASON = "Baja de la cuenta del alumno";

export type AssignmentCancellationSource = "ADMIN_INDIVIDUAL" | "STUDENT_WITHDRAWAL";

export type AssignmentCancellationRecord = {
  id?: string;
  assignmentId: string;
  studentProfileId: string;
  templateId: string;
  source: AssignmentCancellationSource;
  cancelledByUserId: string;
  cancelledAt: Date;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledReservationIds: string[];
  ambiguousReservationIds: string[];
  regulationVersionId: string | null;
};

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Shared audit writer for individual cancellations and account withdrawals. */
export async function recordAssignmentCancellations(
  tx: TransactionClient,
  records: AssignmentCancellationRecord[],
): Promise<void> {
  if (!records.length) return;
  await tx.insert(studentTemplateAssignmentCancellations).values(records.map((record) => ({
    ...record,
    id: record.id ?? randomUUID(),
  })));
}

function cancellationResult(
  row: typeof studentTemplateAssignmentCancellations.$inferSelect,
  cancelled: boolean,
) {
  return {
    assignmentId: row.assignmentId,
    cancellationId: row.id,
    cancelled,
    cancelledAt: row.cancelledAt,
    source: row.source,
    cancelledReservationIds: row.cancelledReservationIds,
    ambiguousReservationIds: row.ambiguousReservationIds,
    requiresAdministrativeReview: row.ambiguousReservationIds.length,
  };
}

/**
 * Cancels a habitual template assignment whose first local day has not begun yet.
 *
 * The assignment row, its immutable audit record and the future reservations that
 * persist this exact assignment as their provenance are written together. Unlinked
 * CONFIRMED reservations remain untouched and are reported for manual review.
 * Credits, capacity and pending requests are intentionally left untouched.
 */
export async function cancelFutureAssignment(
  actor: { userId: string; role: UserRole },
  input: unknown,
) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Acceso restringido a la administración.", "forbidden", 403, true);
  }
  const payload = cancelFutureAssignmentSchema.parse(input);

  return db.transaction(async (tx) => {
    const [assignment] = await tx.select({
      studentProfileId: studentTemplateAssignments.studentProfileId,
      templateId: studentTemplateAssignments.templateId,
    }).from(studentTemplateAssignments).where(eq(studentTemplateAssignments.id, payload.assignmentId));
    if (!assignment) {
      throw new ApplicationError("No se encontró la asignación.", "assignment_not_found", 404, true);
    }

    // Lock order shared with booking, generation and withdrawal: account, template,
    // sessions, then profile. Sessions are locked before touching reservation rows.
    await requireActiveStudentForBooking(tx, assignment.studentProfileId);
    await lockTemplateAssignments(tx, assignment.templateId);

    const [current] = await tx.select().from(studentTemplateAssignments)
      .where(eq(studentTemplateAssignments.id, payload.assignmentId));
    if (!current) {
      throw new ApplicationError("No se encontró la asignación.", "assignment_not_found", 404, true);
    }

    const [existing] = await tx.select().from(studentTemplateAssignmentCancellations)
      .where(eq(studentTemplateAssignmentCancellations.assignmentId, payload.assignmentId));

    if (existing && current.status !== "CANCELLED") {
      throw new ApplicationError(
        "La asignación tiene una auditoría de anulación pero no figura anulada. Requiere revisión administrativa.",
        "assignment_cancellation_inconsistent", 409, true,
      );
    }

    if (current.status === "CANCELLED") {
      if (!existing) {
        throw new ApplicationError(
          "La asignación figura anulada sin auditoría asociada. Requiere revisión administrativa.",
          "assignment_cancelled_without_audit", 409, true,
        );
      }
      // A retry is idempotent even after the original start date has passed.
      return cancellationResult(existing, false);
    }

    const withinWindow = current.effectiveTo
      ? and(gte(classSessions.localDate, current.effectiveFrom), lte(classSessions.localDate, current.effectiveTo))
      : gte(classSessions.localDate, current.effectiveFrom);
    const candidates = tx.select({ id: classSessions.id }).from(classSessions)
      .where(and(
        eq(classSessions.templateId, current.templateId),
        withinWindow,
        gt(classSessions.startsAtUtc, sql`clock_timestamp()`),
      ))
      .orderBy(asc(classSessions.id));
    await candidates.for("no key update");

    await lockStudentProfile(tx, current.studentProfileId);

    // Sample the database clock once, after every wait, so the local day cannot change
    // between validation and the writes. The same instant is reused for the audit.
    // Raw execute returns timestamps as text, so the instant is read as Unix epoch seconds.
    const { rows: [clock] } = await tx.execute<{ localDate: string; cancelledAtEpoch: string }>(sql`
      select to_char(clock_timestamp() at time zone 'Europe/Copenhagen', 'YYYY-MM-DD') as "localDate",
        extract(epoch from clock_timestamp()) as "cancelledAtEpoch"
    `);
    const localDate = clock.localDate;
    const cancelledAt = new Date(Number(clock.cancelledAtEpoch) * 1000);
    if (current.effectiveFrom <= localDate) {
      throw new ApplicationError(
        "La asignación ya ha comenzado. Usa la finalización ordinaria.",
        "assignment_already_started", 409, true,
      );
    }
    // A reservation supported by another live assignment for the same course must stay:
    // the annulled assignment is not its only provenance.
    const hasNoOtherLiveAssignment = notExists(tx.select({ id: studentTemplateAssignments.id })
      .from(studentTemplateAssignments).where(and(
        eq(studentTemplateAssignments.studentProfileId, current.studentProfileId),
        eq(studentTemplateAssignments.templateId, current.templateId),
        ne(studentTemplateAssignments.id, current.id),
        ne(studentTemplateAssignments.status, "CANCELLED"),
        lte(studentTemplateAssignments.effectiveFrom, classSessions.localDate),
        or(
          isNull(studentTemplateAssignments.effectiveTo),
          gte(studentTemplateAssignments.effectiveTo, classSessions.localDate),
        ),
      )));
    // Only reservations that persist this exact assignment are attributable. Anything
    // else stays CONFIRMED and is reported as ambiguous for administrative review.
    const attributable = and(
      eq(classReservations.studentProfileId, current.studentProfileId),
      eq(classReservations.status, "CONFIRMED"),
      eq(classReservations.habitualAssignmentId, current.id),
      eq(classSessions.templateId, current.templateId),
      withinWindow,
      gt(classSessions.startsAtUtc, sql`clock_timestamp()`),
      hasNoOtherLiveAssignment,
    );
    const attributableReservations = await tx.select({ id: classReservations.id })
      .from(classReservations)
      .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
      .where(attributable)
      .orderBy(asc(classReservations.id))
      .for("no key update", { of: classReservations });
    const cancelledReservationIds = attributableReservations.map(({ id }) => id);
    const regulation = await resolveCurrentAcademicRegulation(tx, cancelledAt);

    if (cancelledReservationIds.length) {
      await tx.update(classReservations)
        .set({
          status: "CANCELLED",
          cancelledAt,
          cancelledByUserId: actor.userId,
          cancellationRegulationVersionId: regulation.id,
          updatedAt: cancelledAt,
        })
        .where(and(
          inArray(classReservations.id, cancelledReservationIds),
          eq(classReservations.status, "CONFIRMED"),
        ));
    }

    const ambiguousReservations = await tx.select({ id: classReservations.id })
      .from(classReservations)
      .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
      .where(and(
        eq(classReservations.studentProfileId, current.studentProfileId),
        eq(classReservations.status, "CONFIRMED"),
        eq(classReservations.origin, "ORDINARY"),
        eq(classSessions.templateId, current.templateId),
        withinWindow,
        gt(classSessions.startsAtUtc, sql`clock_timestamp()`),
        hasNoOtherLiveAssignment,
      ))
      .orderBy(classReservations.id);
    const ambiguousReservationIds = ambiguousReservations.map(({ id }) => id);
    const cancellationId = randomUUID();

    await tx.update(studentTemplateAssignments)
      .set({ status: "CANCELLED", updatedAt: cancelledAt })
      .where(eq(studentTemplateAssignments.id, payload.assignmentId));
    await recordAssignmentCancellations(tx, [{
      id: cancellationId,
      assignmentId: current.id,
      studentProfileId: current.studentProfileId,
      templateId: current.templateId,
      source: "ADMIN_INDIVIDUAL",
      cancelledByUserId: actor.userId,
      cancelledAt,
      reason: payload.reason,
      effectiveFrom: current.effectiveFrom,
      effectiveTo: current.effectiveTo,
      cancelledReservationIds,
      ambiguousReservationIds,
      regulationVersionId: regulation.id,
    }]);

    return {
      assignmentId: current.id,
      cancellationId,
      cancelled: true,
      cancelledAt,
      source: "ADMIN_INDIVIDUAL" as const,
      cancelledReservationIds,
      ambiguousReservationIds,
      requiresAdministrativeReview: ambiguousReservationIds.length,
    };
  });
}

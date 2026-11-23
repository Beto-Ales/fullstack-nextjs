import "server-only";

import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { regulationDate } from "@/src/application/academic/regulation-service";
import { studentEditVersion } from "@/src/application/academic/student-edit-service";
import {
  cancellationActorId, cancellationSource, cancelledReservation as cancelled, currentClassAttendance, historicalClass,
  reservationHasHabitualAssignment, selectHabitualSchedules, sessionCancellation, studentClassDetails, withdrawalCancellation,
} from "@/src/application/academic/student-class-queries";
import { readAdminCreditOverview, type TransactionClient } from "@/src/application/credits/credit-service";
import { recoveryReservationScope, selectRecoveryMovements } from "@/src/application/recovery/recovery-service";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import {
  classReservations, classSessions, classTemplates, reservationAttendanceRecords, reservationCancellations,
  studentProfileEdits, studentProfiles, studentTemplateAssignmentCancellations, studentWithdrawals, users,
} from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

const PAGE_SIZE = 20;
export type ProfilePageKey = "horarios" | "proximas" | "historial" | "movimientos" | "recuperaciones" | "modificaciones";
const editFields = ["firstName", "lastName", "email", "contactEmail", "contactPhone"] as const;

function readPage(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,5}$/.test(value)) return 1;
  return Number(value);
}

function auditValue(change: unknown, key: "before" | "after") {
  if (!change || typeof change !== "object" || !Object.hasOwn(change, key)) return undefined;
  const value: unknown = (change as Record<string, unknown>)[key];
  return typeof value === "string" || value === null ? value : undefined;
}

function profileEditChanges(changes: unknown) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return editFields.flatMap((field) => {
    if (!Object.hasOwn(changes, field)) return [];
    const change = (changes as Record<string, unknown>)[field];
    const before = auditValue(change, "before");
    const after = auditValue(change, "after");
    return before !== undefined && before === after ? [] : [{ field, before, after }];
  });
}

async function readProfileEdits(reader: TransactionClient, studentProfileId: string, number: number) {
  const query = (page: number) => reader.select({
    id: studentProfileEdits.id,
    editedAt: studentProfileEdits.editedAt,
    actorId: studentProfileEdits.editedByUserId,
    actorEmail: users.email,
    operation: studentProfileEdits.operation,
    changes: studentProfileEdits.changes,
  }).from(studentProfileEdits)
    .leftJoin(users, eq(users.id, studentProfileEdits.editedByUserId))
    .where(eq(studentProfileEdits.studentProfileId, studentProfileId))
    .orderBy(desc(studentProfileEdits.editedAt), desc(studentProfileEdits.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);

  let rows = await query(number);
  if (!rows.length && number > 1) {
    number = 1;
    rows = await query(number);
  }
  return {
    number,
    hasNext: rows.length > PAGE_SIZE,
    items: rows.slice(0, PAGE_SIZE).map(({ operation, changes, actorEmail, ...row }) => ({
      ...row,
      operation: operation === "UPDATE_STUDENT_DETAILS" ? operation : null,
      actorEmail: actorEmail?.trim() || null,
      changes: profileEditChanges(changes),
    })),
  };
}

export type AmbiguousReservationReview = {
  reservationId: string;
  sessionId: string | null;
  courseName: string | null;
  origin: "ORDINARY" | "MAKEUP" | null;
  reservationStatus: "CONFIRMED" | "CANCELLED" | null;
  cancellationSource: "STUDENT_REQUEST" | "ADMIN_DECISION" | null;
  cancelledAt: Date | null;
  sessionStatus: "SCHEDULED" | "CANCELLED" | "COMPLETED" | null;
  startsAtUtc: Date | null;
  endsAtUtc: Date | null;
  requiresReview: boolean;
};

type AssignmentCancellationSummary = {
  source: "ADMIN_INDIVIDUAL" | "STUDENT_WITHDRAWAL";
  cancelledAt: Date;
  reason: string;
  cancelledByEmail: string | null;
  ambiguousCount: number;
  ambiguousReviews: {
    historicalCount: number;
    needsReviewCount: number;
    items: AmbiguousReservationReview[];
  };
};

/**
 * Reads the current state of the reservations recorded in an immutable cancellation audit.
 *
 * The audit keeps the historical identifiers; this query never rewrites or re-derives them.
 * A record still needs review only while it exists for this student, remains CONFIRMED and
 * belongs to a SCHEDULED session that has not ended yet. Missing records (deleted or owned by
 * another student) are reported as unresolved so an administrator can check them manually.
 */
async function readAmbiguousReservationReviews(
  reader: TransactionClient, studentProfileId: string, reservationIds: string[], now: Date,
) {
  const uniqueIds = [...new Set(reservationIds)];
  const reviews = new Map<string, AmbiguousReservationReview>();
  if (!uniqueIds.length) return reviews;

  const rows = await reader.select({
    reservationId: classReservations.id,
    reservationStatus: classReservations.status,
    origin: classReservations.origin,
    cancelledAt: classReservations.cancelledAt,
    sessionId: classSessions.id,
    sessionStatus: classSessions.status,
    startsAtUtc: classSessions.startsAtUtc,
    endsAtUtc: classSessions.endsAtUtc,
    courseName: classTemplates.name,
    cancellationSource: reservationCancellations.decisionSource,
  }).from(classReservations)
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .leftJoin(classTemplates, eq(classTemplates.id, classSessions.templateId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .where(and(
      eq(classReservations.studentProfileId, studentProfileId),
      inArray(classReservations.id, uniqueIds),
    ));

  for (const row of rows) {
    const actionable = row.reservationStatus === "CONFIRMED"
      && row.sessionStatus === "SCHEDULED"
      && row.endsAtUtc > now;
    reviews.set(row.reservationId, { ...row, requiresReview: actionable });
  }

  for (const reservationId of uniqueIds) {
    if (!reviews.has(reservationId)) {
      reviews.set(reservationId, {
        reservationId, sessionId: null, courseName: null, origin: null, reservationStatus: null,
        cancellationSource: null, cancelledAt: null, sessionStatus: null, startsAtUtc: null,
        endsAtUtc: null, requiresReview: true,
      });
    }
  }
  return reviews;
}

function reviewItems(reviews: Map<string, AmbiguousReservationReview>, reservationIds: string[]) {
  return [...new Set(reservationIds)]
    .map((id) => reviews.get(id))
    .filter((review): review is AmbiguousReservationReview => review !== undefined)
    .sort((first, second) => {
      if (!first.startsAtUtc) return second.startsAtUtc ? 1 : first.reservationId.localeCompare(second.reservationId);
      if (!second.startsAtUtc) return -1;
      return first.startsAtUtc.getTime() - second.startsAtUtc.getTime();
    });
}

async function readAssignmentCancellations(
  reader: TransactionClient, assignmentIds: string[], studentProfileId: string, now: Date,
) {
  if (!assignmentIds.length) return new Map<string, AssignmentCancellationSummary>();

  const actor = alias(users, "assignment_cancellation_actor");
  const rows = await reader.select({
    assignmentId: studentTemplateAssignmentCancellations.assignmentId,
    source: studentTemplateAssignmentCancellations.source,
    cancelledAt: studentTemplateAssignmentCancellations.cancelledAt,
    reason: studentTemplateAssignmentCancellations.reason,
    cancelledByEmail: actor.email,
    ambiguousReservationIds: studentTemplateAssignmentCancellations.ambiguousReservationIds,
  }).from(studentTemplateAssignmentCancellations)
    .leftJoin(actor, eq(actor.id, studentTemplateAssignmentCancellations.cancelledByUserId))
    .where(inArray(studentTemplateAssignmentCancellations.assignmentId, assignmentIds));

  const reviews = await readAmbiguousReservationReviews(
    reader, studentProfileId, rows.flatMap(({ ambiguousReservationIds }) => ambiguousReservationIds), now,
  );

  return new Map(rows.map(({ ambiguousReservationIds, cancelledByEmail, ...row }) => {
    const items = reviewItems(reviews, ambiguousReservationIds);
    return [row.assignmentId, {
      ...row,
      cancelledByEmail: cancelledByEmail?.trim() || null,
      ambiguousCount: ambiguousReservationIds.length,
      ambiguousReviews: {
        historicalCount: ambiguousReservationIds.length,
        needsReviewCount: items.filter(({ requiresReview }) => requiresReview).length,
        items,
      },
    }] as const;
  }));
}

function selectClassActivity(reader: TransactionClient) {
  const cancellationActor = alias(users, "cancellation_actor");
  const attendanceActor = alias(users, "attendance_actor");
  return reader.select({
    ...studentClassDetails,
    classSessionId: classSessions.id,
    habitual: sql<boolean>`coalesce(${reservationCancellations.isHabitualReservation}, ${reservationHasHabitualAssignment})`,
    cancelled: sql<boolean>`${cancelled}`,
    cancellationSource,
    withdrawalCancellation,
    sessionCancellation: sql<boolean>`${sessionCancellation(reader)}`,
    cancellationType: reservationCancellations.cancellationType,
    cancellationActorEmail: cancellationActor.email,
    administrativeReason: reservationCancellations.administrativeReason,
    cancelledAt: sql<Date | null>`coalesce(${reservationCancellations.cancelledAt}, ${classReservations.cancelledAt})`
      .mapWith(classReservations.cancelledAt),
    attendanceOutcome: reservationAttendanceRecords.outcome,
    attendanceSource: reservationAttendanceRecords.source,
    attendanceRecordedAt: reservationAttendanceRecords.recordedAt,
    attendanceActorEmail: attendanceActor.email,
    correctionReason: reservationAttendanceRecords.correctionReason,
  }).from(classReservations)
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .innerJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .leftJoin(classTemplates, eq(classTemplates.id, classSessions.templateId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .leftJoin(reservationAttendanceRecords, currentClassAttendance)
    .leftJoin(studentWithdrawals, eq(studentWithdrawals.studentUserId, studentProfiles.userId))
    .leftJoin(cancellationActor, eq(cancellationActor.id, cancellationActorId))
    .leftJoin(attendanceActor, eq(attendanceActor.id, reservationAttendanceRecords.recordedByUserId));
}

export type ProfileClassEntry = Awaited<ReturnType<typeof selectClassActivity>>[number];

async function readActivityTotals(reader: TransactionClient, scope: SQL) {
  const [totals] = await reader.select({
    attended: sql<number>`count(*) filter (where ${reservationAttendanceRecords.outcome} = 'ATTENDED')`.mapWith(Number),
    absent: sql<number>`count(*) filter (where ${reservationAttendanceRecords.outcome} = 'ABSENT')`.mapWith(Number),
    studentCancellations: sql<number>`count(*) filter (where ${cancellationSource} = 'STUDENT_REQUEST')`.mapWith(Number),
    adminCancellations: sql<number>`count(*) filter (where ${cancellationSource} = 'ADMIN_DECISION')`.mapWith(Number),
    recoveries: sql<number>`count(*) filter (where ${classReservations.origin} = 'MAKEUP')`.mapWith(Number),
  }).from(classReservations)
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .innerJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .leftJoin(reservationAttendanceRecords, currentClassAttendance)
    .where(scope);
  return totals;
}

export async function getAdminStudentProfile(
  actor: { role: UserRole; userId: string }, studentProfileId: unknown, query: Record<string, unknown> = {}, now = new Date(),
) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Acceso restringido a la administración.", "forbidden", 403, true);
  }
  const id = z.uuid().safeParse(studentProfileId);
  if (!id.success) return null;

  function offset(key: ProfilePageKey) {
    return (readPage(query[key]) - 1) * PAGE_SIZE;
  }

  function page<T>(key: ProfilePageKey, rows: T[]) {
    return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE, number: readPage(query[key]) };
  }

  return db.transaction(async (tx) => {
    const [account] = await tx.select({
      editVersion: studentEditVersion,
      id: studentProfiles.id,
      firstName: studentProfiles.firstName,
      lastName: studentProfiles.lastName,
      email: users.email,
      contactEmail: studentProfiles.contactEmail,
      contactPhone: studentProfiles.contactPhone,
      status: users.status,
      createdAt: users.createdAt,
      deactivatedAt: users.deactivatedAt,
    }).from(studentProfiles)
      .innerJoin(users, eq(users.id, studentProfiles.userId))
      .where(and(eq(studentProfiles.id, id.data), eq(users.role, "STUDENT")))
      .limit(1);
    if (!account) return null;
    const { editVersion, ...student } = account;

    const limit = PAGE_SIZE + 1;
    const scope = eq(classReservations.studentProfileId, student.id);
    const scheduleRows = await selectHabitualSchedules(tx, regulationDate(now), eq(studentProfiles.id, student.id), true)
      .limit(limit).offset(offset("horarios"));
    const assignmentCancellations = await readAssignmentCancellations(
      tx, scheduleRows.map(({ assignmentId }) => assignmentId), student.id, now,
    );
    const schedules = scheduleRows.map((schedule) => ({
      ...schedule,
      cancellation: assignmentCancellations.get(schedule.assignmentId) ?? null,
    }));
    const upcoming = await selectClassActivity(tx).where(and(
      scope,
      eq(classReservations.status, "CONFIRMED"),
      eq(classSessions.status, "SCHEDULED"),
      isNull(reservationCancellations.id),
      gt(classSessions.startsAtUtc, now),
    )).orderBy(classSessions.startsAtUtc, classReservations.id).limit(limit).offset(offset("proximas"));
    const history = await selectClassActivity(tx).where(and(scope, or(historicalClass(now), cancelled)))
      .orderBy(desc(classSessions.startsAtUtc), desc(classReservations.id)).limit(limit).offset(offset("historial"));
    const recoveries = page("recuperaciones", await selectClassActivity(tx).where(recoveryReservationScope(student.id))
      .orderBy(desc(classSessions.startsAtUtc), desc(classReservations.id)).limit(limit).offset(offset("recuperaciones")));
    const recoveryMovements = await selectRecoveryMovements(tx, student.id, recoveries.items.map(({ reservationId }) => reservationId));
    const movementsByReservation = new Map<string, typeof recoveryMovements>();
    for (const movement of recoveryMovements) {
      if (!movement.relatedReservationId) continue;
      const items = movementsByReservation.get(movement.relatedReservationId) ?? [];
      items.push(movement);
      movementsByReservation.set(movement.relatedReservationId, items);
    }
    const totals = await readActivityTotals(tx, scope);
    const { movements, availableExpirations, ...creditSummary } = await readAdminCreditOverview(
      actor, tx, student.id, now, limit, offset("movimientos"),
    );
    const datedExpirations = availableExpirations.filter(({ expiresAt }) => expiresAt !== null);
    const edits = await readProfileEdits(tx, student.id, readPage(query.modificaciones));

    return {
      student,
      editVersion,
      edits,
      totals,
      schedules: page("horarios", schedules),
      upcoming: page("proximas", upcoming),
      history: page("historial", history),
      recoveries: {
        ...recoveries,
        items: recoveries.items.map((entry) => ({ ...entry, movements: movementsByReservation.get(entry.reservationId) ?? [] })),
      },
      credits: { ...creditSummary, nextExpirations: datedExpirations.slice(0, 5), moreExpirations: datedExpirations.length > 5 },
      movements: page("movimientos", movements),
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

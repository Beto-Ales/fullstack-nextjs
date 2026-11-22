import "server-only";

import { and, desc, eq, exists, gt, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { regulationDate } from "@/src/application/academic/regulation-service";
import {
  currentClassAttendance, historicalClass, reservationHasHabitualAssignment, selectHabitualSchedules, studentClassDetails,
} from "@/src/application/academic/student-class-queries";
import { readAdminCreditOverview, type TransactionClient } from "@/src/application/credits/credit-service";
import { recoveryReservationScope, selectRecoveryMovements } from "@/src/application/recovery/recovery-service";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import {
  classReservations, classSessionEdits, classSessions, classTemplates, reservationAttendanceRecords, reservationCancellations,
  studentProfiles, studentWithdrawals, users,
} from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

const PAGE_SIZE = 20;
export type ProfilePageKey = "horarios" | "proximas" | "historial" | "movimientos" | "recuperaciones";
const cancellationActorId = sql`coalesce(${reservationCancellations.cancelledByUserId}, ${classReservations.cancelledByUserId})`;
const cancelled = or(eq(classReservations.status, "CANCELLED"), isNotNull(reservationCancellations.id))!;
const cancellationSource = sql<"STUDENT_REQUEST" | "ADMIN_DECISION" | null>`case when ${cancelled}
  then coalesce(${reservationCancellations.decisionSource},
    case when ${cancellationActorId} = ${studentProfiles.userId} then 'STUDENT_REQUEST'::reservation_cancellation_source end)
  end`;

function readPage(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,5}$/.test(value)) return 1;
  return Number(value);
}

function selectClassActivity(reader: TransactionClient) {
  const cancellationActor = alias(users, "cancellation_actor");
  const attendanceActor = alias(users, "attendance_actor");
  const withdrawalCancellation = sql<boolean>`coalesce(
    ${studentWithdrawals.releasedReservationIds} @> jsonb_build_array(${classReservations.id})
    or ${studentWithdrawals.cancelledRecoveries} @> jsonb_build_array(jsonb_build_object('reservationId', ${classReservations.id})),
    false
  )`;
  const sessionCancellation = exists(reader.select({ id: classSessionEdits.id }).from(classSessionEdits).where(and(
    eq(classSessionEdits.classSessionId, classSessions.id),
    eq(classSessionEdits.status, "CANCELLED"),
    eq(classSessionEdits.editedAt, classReservations.cancelledAt),
    eq(classSessionEdits.editedByUserId, classReservations.cancelledByUserId),
  )));
  return reader.select({
    ...studentClassDetails,
    classSessionId: classSessions.id,
    habitual: sql<boolean>`coalesce(${reservationCancellations.isHabitualReservation}, ${reservationHasHabitualAssignment})`,
    cancelled: sql<boolean>`${cancelled}`,
    cancellationSource,
    withdrawalCancellation,
    sessionCancellation: sql<boolean>`${sessionCancellation}`,
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
    const [student] = await tx.select({
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
    if (!student) return null;

    const limit = PAGE_SIZE + 1;
    const scope = eq(classReservations.studentProfileId, student.id);
    const schedules = await selectHabitualSchedules(tx, regulationDate(now), eq(studentProfiles.id, student.id), true)
      .limit(limit).offset(offset("horarios"));
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

    return {
      student,
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

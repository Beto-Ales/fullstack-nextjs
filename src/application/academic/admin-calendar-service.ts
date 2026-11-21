import "server-only";

import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { calculateAvailableSpots, getSessionBookingStatus } from "@/src/domain/academic/availability";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import { activeHabitualStudents, sessionUsageCounts } from "@/src/infrastructure/db/habitual-reservations.mjs";
import { classReservations, classSessions, classTemplates, reservationAttendanceRecords, reservationCancellations, sessionCapacityBlocks, studentProfiles, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

function requireCalendarAdmin(actor: { role: UserRole }) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
}

type AdminSessionReader = Pick<typeof db, "select">;

function selectAdminSessions(now: Date, reader: AdminSessionReader = db) {
  const habitualStudents = activeHabitualStudents({ templateId: classSessions.templateId, localDate: classSessions.localDate });
  const usage = sessionUsageCounts(classSessions.id);
  return reader.select({
    id: classSessions.id,
    name: classTemplates.name,
    startsAtUtc: classSessions.startsAtUtc,
    endsAtUtc: classSessions.endsAtUtc,
    sessionStatus: classSessions.status,
    maxCapacity: classSessions.maxCapacity,
    confirmedReservations: usage.confirmedReservations.as("confirmed_reservations"),
    blockedSpots: usage.blockedSpots.as("blocked_spots"),
    habitualPending: sql<number | null>`
      case when ${classSessions.status} = 'SCHEDULED'
        and ${classSessions.startsAtUtc} > ${now.toISOString()}::timestamptz
        and ${classTemplates.status} = 'ACTIVE'
        and ${classTemplates.effectiveFrom} <= ${classSessions.localDate}
        and (${classTemplates.effectiveTo} is null or ${classTemplates.effectiveTo} >= ${classSessions.localDate})
      then (
        select count(*)::int from (${habitualStudents}) habitual
        where not exists (
          select 1 from class_reservations r
          where r.class_session_id = ${classSessions.id}
            and r.student_profile_id = habitual.student_profile_id
            and (
              r.status = 'CONFIRMED'
              or (r.status = 'CANCELLED' and r.origin = 'ORDINARY' and (
                r.cancelled_by_user_id = habitual.user_id
                or exists (
                  select 1 from reservation_cancellations c
                  where c.reservation_id = r.id and c.decision_source = 'ADMIN_DECISION'
                )
              ))
            )
        )
      ) end`.as("habitual_pending"),
  }).from(classSessions)
    .leftJoin(classTemplates, eq(classSessions.templateId, classTemplates.id));
}

type AdminSession = Awaited<ReturnType<typeof selectAdminSessions>>[number];

function summarizeCapacity(session: AdminSession, regulationCapacity: number, now: Date) {
  const { maxCapacity: physicalCapacity, confirmedReservations, blockedSpots, habitualPending } = session;
  const capacity = Math.min(physicalCapacity, regulationCapacity);
  const availableSpots = calculateAvailableSpots({ capacity, confirmedReservations, blockedSpots });
  const bookingStatus = getSessionBookingStatus(session, now);

  return {
    physicalCapacity,
    capacity,
    confirmedReservations,
    blockedSpots,
    physicallyFreeSpots: calculateAvailableSpots({ capacity: physicalCapacity, confirmedReservations, blockedSpots }),
    reservableSpots: bookingStatus === "UPCOMING" ? availableSpots : 0,
    bookingStatus,
    habitualPending,
    capacityConflict: habitualPending !== null && habitualPending > availableSpots,
    capacityExcess: Math.max(confirmedReservations + blockedSpots - capacity, 0),
  };
}

export async function listAdminCalendarSessions(actor: { role: UserRole }, start: Date, end: Date, now: Date) {
  requireCalendarAdmin(actor);
  const regulation = await resolveCurrentAcademicRegulation(db, now);
  const sessions = await selectAdminSessions(now)
    .where(and(gte(classSessions.startsAtUtc, start), lt(classSessions.startsAtUtc, end)))
    .orderBy(classSessions.startsAtUtc, classSessions.id);

  return sessions.map((session) => ({ ...session, ...summarizeCapacity(session, regulation.maxClassCapacity, now) }));
}

export async function getAdminCalendarSessionDetails(actor: { role: UserRole }, sessionId: string, now = new Date()) {
  requireCalendarAdmin(actor);
  if (!z.uuid().safeParse(sessionId).success) return null;
  return db.transaction((tx) => readSessionDetails(tx, sessionId, now), { isolationLevel: "repeatable read", accessMode: "read only" });
}

async function readSessionDetails(reader: AdminSessionReader, sessionId: string, now: Date) {
  const regulation = await resolveCurrentAcademicRegulation(reader, now);
  const selectedSession = selectAdminSessions(now, reader).where(eq(classSessions.id, sessionId)).limit(1).as("selected_session");
  const cancelledAt = sql<Date | null>`coalesce(${reservationCancellations.cancelledAt}, ${classReservations.cancelledAt})`
    .mapWith(classReservations.cancelledAt);
  const rows = await reader.select({
    id: selectedSession.id,
    name: selectedSession.name,
    startsAtUtc: selectedSession.startsAtUtc,
    endsAtUtc: selectedSession.endsAtUtc,
    sessionStatus: selectedSession.sessionStatus,
    maxCapacity: selectedSession.maxCapacity,
    confirmedReservations: selectedSession.confirmedReservations,
    blockedSpots: selectedSession.blockedSpots,
    habitualPending: selectedSession.habitualPending,
    reservationId: classReservations.id,
    status: classReservations.status,
    origin: classReservations.origin,
    firstName: studentProfiles.firstName,
    lastName: studentProfiles.lastName,
    attendanceOutcome: reservationAttendanceRecords.outcome,
    cancellationId: reservationCancellations.id,
    cancelledAt,
    cancelledByRole: users.role,
    cancellationSource: reservationCancellations.decisionSource,
    administrativeReason: reservationCancellations.administrativeReason,
    cancelledByEmail: users.email,
    cancellationType: reservationCancellations.cancellationType,
    nonEligibilityReason: reservationCancellations.nonEligibilityReason,
  }).from(selectedSession)
    .leftJoin(classReservations, eq(classReservations.classSessionId, selectedSession.id))
    .leftJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .leftJoin(reservationAttendanceRecords, and(
      eq(reservationAttendanceRecords.reservationId, classReservations.id),
      eq(reservationAttendanceRecords.classSessionId, selectedSession.id),
      isNull(reservationAttendanceRecords.supersededAt),
    ))
    .leftJoin(users, eq(users.id, sql`coalesce(${reservationCancellations.cancelledByUserId}, ${classReservations.cancelledByUserId})`))
    .orderBy(sql`case when ${classReservations.status} = 'CANCELLED' or ${reservationCancellations.id} is not null
      then ${cancelledAt} end desc nulls last`,
      studentProfiles.lastName, studentProfiles.firstName, classReservations.id);

  if (!rows.length) return null;
  const session = rows[0];
  const { name, startsAtUtc, endsAtUtc, sessionStatus } = session;
  const enrollments = rows.filter((row) => row.status === "CONFIRMED" && row.cancellationId === null);
  const creator = alias(users, "capacity_block_creator");
  const releaser = alias(users, "capacity_block_releaser");
  const capacityBlocks = await reader.select({
    id: sessionCapacityBlocks.id,
    blockedSpots: sessionCapacityBlocks.blockedSpots,
    isActive: sessionCapacityBlocks.isActive,
    reason: sessionCapacityBlocks.reason,
    createdAt: sessionCapacityBlocks.createdAt,
    createdBy: creator.email,
    releasedAt: sessionCapacityBlocks.releasedAt,
    releasedBy: releaser.email,
    releaseReason: sessionCapacityBlocks.releaseReason,
  }).from(sessionCapacityBlocks)
    .leftJoin(creator, eq(creator.id, sessionCapacityBlocks.blockedByUserId))
    .leftJoin(releaser, eq(releaser.id, sessionCapacityBlocks.releasedByUserId))
    .where(eq(sessionCapacityBlocks.classSessionId, sessionId))
    .orderBy(desc(sessionCapacityBlocks.isActive), desc(sessionCapacityBlocks.createdAt), sessionCapacityBlocks.id);
  return {
    name,
    startsAtUtc,
    endsAtUtc,
    sessionStatus,
    capacityOverview: {
      ...summarizeCapacity(session, regulation.maxClassCapacity, now),
      confirmedWithCancellation: session.confirmedReservations - enrollments.length,
    },
    capacityBlocks,
    enrollments,
    cancellations: rows.filter((row) => row.status === "CANCELLED" || row.cancellationId !== null),
  };
}

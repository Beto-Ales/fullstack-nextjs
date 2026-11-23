import "server-only";

import { and, desc, eq, gte, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DateTime } from "luxon";
import { z } from "zod";

import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { cancellationSource, cancelledReservation, currentClassAttendance, sessionCancellation, withdrawalCancellation } from "./student-class-queries";
import { calculateAvailableSpots, calculateReservableSpots, getSessionBookingStatus } from "@/src/domain/academic/availability";
import type { UserRole } from "@/src/domain/auth/roles";
import { resolveCenterWeek } from "@/src/domain/time/center-week";
import { db } from "@/src/infrastructure/db/client";
import { activeHabitualStudents, sessionUsageCounts } from "@/src/infrastructure/db/habitual-reservations.mjs";
import { classReservations, classSessions, classTemplates, reservationAttendanceRecords, reservationCancellations, sessionCapacityBlocks, studentProfiles, studentWithdrawals, users } from "@/src/infrastructure/db/schema";
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
    reservableSpots: calculateReservableSpots({ bookingStatus, capacity, confirmedReservations, blockedSpots }),
    bookingStatus,
    habitualPending,
    capacityConflict: habitualPending !== null && habitualPending > availableSpots,
    capacityExcess: Math.max(confirmedReservations + blockedSpots - capacity, 0),
  };
}

export async function listAdminCalendarSessions(actor: { role: UserRole }, start: Date, end: Date, now: Date) {
  requireCalendarAdmin(actor);
  const regulation = await resolveCurrentAcademicRegulation(db, now);
  return readCalendarSessions(db, weekRange(start, end), regulation.maxClassCapacity, now);
}

function weekRange(start: Date, end: Date) {
  return and(gte(classSessions.startsAtUtc, start), lt(classSessions.startsAtUtc, end))!;
}

async function readCalendarSessions(reader: AdminSessionReader, range: SQL, capacity: number, now: Date) {
  const sessions = await selectAdminSessions(now, reader).where(range)
    .orderBy(classSessions.startsAtUtc, classSessions.id);

  return sessions.map((session) => ({ ...session, ...summarizeCapacity(session, capacity, now) }));
}

function countWhen(condition: SQL | undefined) {
  return sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
}

async function readWeeklyActivity(reader: AdminSessionReader, range: SQL, now: Date) {
  const eligible = and(
    ne(classSessions.status, "CANCELLED"), lte(classSessions.endsAtUtc, now),
    eq(classReservations.status, "CONFIRMED"), isNull(reservationCancellations.id),
  );
  const student = eq(cancellationSource, "STUDENT_REQUEST");
  const admin = eq(cancellationSource, "ADMIN_DECISION");
  const documented = or(withdrawalCancellation, sessionCancellation(reader));
  const [counts] = await reader.select({
    attended: countWhen(and(eligible, eq(reservationAttendanceRecords.outcome, "ATTENDED"))),
    absent: countWhen(and(eligible, eq(reservationAttendanceRecords.outcome, "ABSENT"))),
    pending: countWhen(and(eligible, isNull(reservationAttendanceRecords.id))),
    early: countWhen(and(student, eq(reservationCancellations.cancellationType, "ON_TIME"))),
    late: countWhen(and(student, eq(reservationCancellations.cancellationType, "LATE"))),
    studentWithoutTiming: countWhen(and(student, isNull(reservationCancellations.cancellationType))),
    administrative: countWhen(admin),
    other: countWhen(and(cancelledReservation, isNull(cancellationSource), documented)),
    unknown: countWhen(and(cancelledReservation, isNull(cancellationSource), sql`not (${documented})`)),
  }).from(classSessions)
    .innerJoin(classReservations, eq(classReservations.classSessionId, classSessions.id))
    .innerJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .leftJoin(reservationAttendanceRecords, and(currentClassAttendance, eq(reservationAttendanceRecords.classSessionId, classSessions.id)))
    .leftJoin(studentWithdrawals, eq(studentWithdrawals.studentUserId, studentProfiles.userId))
    .where(range);
  return counts;
}

export async function getAdminWeeklyOverview(actor: { role: UserRole }, requestedWeek: unknown, now = new Date()) {
  requireCalendarAdmin(actor);
  const { week } = resolveCenterWeek(requestedWeek, DateTime.fromJSDate(now));
  const range = weekRange(week.toJSDate(), week.plus({ weeks: 1 }).toJSDate());
  return db.transaction(async (tx) => {
    const regulation = await resolveCurrentAcademicRegulation(tx, now);
    const sessions = await readCalendarSessions(tx, range, regulation.maxClassCapacity, now);
    const activity = await readWeeklyActivity(tx, range, now);
    const sessionCounts = { scheduled: 0, future: 0, inProgress: 0, finished: 0, cancelled: 0, incidents: 0 };
    const capacity = { physical: 0, effective: 0, confirmed: 0, blocked: 0, physicallyFree: 0, reservable: 0, habitualPending: 0 };
    for (const session of sessions) {
      if (session.capacityConflict || session.capacityExcess > 0) sessionCounts.incidents++;
      if (session.bookingStatus === "CANCELLED") {
        sessionCounts.cancelled++;
        continue;
      }
      sessionCounts.scheduled++;
      if (session.endsAtUtc <= now) sessionCounts.finished++;
      else if (session.startsAtUtc <= now) sessionCounts.inProgress++;
      else sessionCounts.future++;
      if (session.bookingStatus !== "UPCOMING") continue;
      capacity.physical += session.physicalCapacity;
      capacity.effective += session.capacity;
      capacity.confirmed += session.confirmedReservations;
      capacity.blocked += session.blockedSpots;
      capacity.physicallyFree += session.physicallyFreeSpots;
      capacity.reservable += session.reservableSpots;
      capacity.habitualPending += session.habitualPending ?? 0;
    }
    return { week, sessions, sessionCounts, activity, capacity, capacityLimit: regulation.maxClassCapacity };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
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
    studentProfileId: studentProfiles.id,
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

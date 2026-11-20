import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { calculateAvailableSpots } from "@/src/domain/academic/availability";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import { activeHabitualStudents, sessionUsageCounts } from "@/src/infrastructure/db/habitual-reservations.mjs";
import { classReservations, classSessions, classTemplates, reservationCancellations, studentProfiles, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

function requireCalendarAdmin(actor: { role: UserRole }) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
}

export async function listAdminCalendarSessions(actor: { role: UserRole }, start: Date, end: Date, now: Date) {
  requireCalendarAdmin(actor);
  const regulation = await resolveCurrentAcademicRegulation(db, now);
  const habitualStudents = activeHabitualStudents({ templateId: classSessions.templateId, localDate: classSessions.localDate });
  const sessions = await db.select({
    id: classSessions.id,
    name: classTemplates.name,
    startsAtUtc: classSessions.startsAtUtc,
    endsAtUtc: classSessions.endsAtUtc,
    sessionStatus: classSessions.status,
    maxCapacity: classSessions.maxCapacity,
    ...sessionUsageCounts(classSessions.id),
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
              or (r.status = 'CANCELLED' and r.origin = 'ORDINARY' and r.cancelled_by_user_id = habitual.user_id)
            )
        )
      ) end`,
  }).from(classSessions)
    .leftJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .where(and(gte(classSessions.startsAtUtc, start), lt(classSessions.startsAtUtc, end)))
    .orderBy(classSessions.startsAtUtc, classSessions.id);

  return sessions.map((session) => {
    const capacity = Math.min(session.maxCapacity, regulation.maxClassCapacity);
    const availableSpots = calculateAvailableSpots({ ...session, capacity });
    const capacityConflict = session.habitualPending !== null && session.habitualPending > availableSpots;
    return { ...session, capacity, availableSpots, capacityConflict };
  });
}

export async function getAdminCalendarSessionDetails(actor: { role: UserRole }, sessionId: string) {
  requireCalendarAdmin(actor);
  const cancelledAt = sql<Date | null>`coalesce(${reservationCancellations.cancelledAt}, ${classReservations.cancelledAt})`
    .mapWith(classReservations.cancelledAt);
  const rows = await db.select({
    name: classTemplates.name,
    startsAtUtc: classSessions.startsAtUtc,
    endsAtUtc: classSessions.endsAtUtc,
    reservationId: classReservations.id,
    status: classReservations.status,
    origin: classReservations.origin,
    firstName: studentProfiles.firstName,
    lastName: studentProfiles.lastName,
    cancelledAt,
    cancelledByRole: users.role,
    cancellationType: reservationCancellations.cancellationType,
    nonEligibilityReason: reservationCancellations.nonEligibilityReason,
  }).from(classSessions)
    .leftJoin(classTemplates, eq(classTemplates.id, classSessions.templateId))
    .leftJoin(classReservations, eq(classReservations.classSessionId, classSessions.id))
    .leftJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .leftJoin(users, eq(users.id, sql`coalesce(${reservationCancellations.cancelledByUserId}, ${classReservations.cancelledByUserId})`))
    .where(eq(classSessions.id, sessionId))
    .orderBy(sql`case when ${classReservations.status} = 'CANCELLED' then ${cancelledAt} end desc nulls last`,
      studentProfiles.lastName, studentProfiles.firstName, classReservations.id);

  if (!rows.length) return null;
  const { name, startsAtUtc, endsAtUtc } = rows[0];
  return {
    name,
    startsAtUtc,
    endsAtUtc,
    enrollments: rows.filter((row) => row.status === "CONFIRMED"),
    cancellations: rows.filter((row) => row.status === "CANCELLED"),
  };
}

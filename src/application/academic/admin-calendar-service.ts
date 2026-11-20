import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { calculateAvailableSpots } from "@/src/domain/academic/availability";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import { activeHabitualStudents, sessionUsageCounts } from "@/src/infrastructure/db/habitual-reservations.mjs";
import { classSessions, classTemplates } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

export async function listAdminCalendarSessions(actor: { role: UserRole }, start: Date, end: Date, now: Date) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
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

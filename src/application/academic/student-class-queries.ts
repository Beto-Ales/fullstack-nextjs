import "server-only";

import { and, eq, isNotNull, isNull, lte, ne, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import type { db } from "@/src/infrastructure/db/client";
import {
  classReservations, classSessions, classTemplates, reservationAttendanceRecords, reservationCancellations,
  studentProfiles, studentTemplateAssignments,
} from "@/src/infrastructure/db/schema";

export function habitualAssignmentExists(input: {
  studentProfileId: string | SQLWrapper;
  templateId: string | SQLWrapper;
  localDate: string | SQLWrapper;
}) {
  return sql<boolean>`exists (
    select 1 from student_template_assignments sta
    where sta.student_profile_id = ${input.studentProfileId}
      and sta.template_id = ${input.templateId}
      and sta.effective_from <= ${input.localDate}
      and (sta.effective_to is null or sta.effective_to >= ${input.localDate})
  )`;
}

export const studentClassDetails = {
  reservationId: classReservations.id,
  origin: classReservations.origin,
  className: classTemplates.name,
  startsAtUtc: classSessions.startsAtUtc,
  endsAtUtc: classSessions.endsAtUtc,
  sessionStatus: classSessions.status,
};

export const reservationHasHabitualAssignment = habitualAssignmentExists({
  studentProfileId: classReservations.studentProfileId,
  templateId: classSessions.templateId,
  localDate: classSessions.localDate,
});

export const currentClassAttendance = and(
  eq(reservationAttendanceRecords.reservationId, classReservations.id),
  isNull(reservationAttendanceRecords.supersededAt),
  eq(classReservations.status, "CONFIRMED"),
  ne(classSessions.status, "CANCELLED"),
  isNull(reservationCancellations.id),
)!;

export function historicalClass(now: Date) {
  return or(
    eq(classReservations.status, "CANCELLED"),
    ne(classSessions.status, "SCHEDULED"),
    lte(classSessions.endsAtUtc, now),
    isNotNull(reservationAttendanceRecords.id),
  )!;
}

export function selectHabitualSchedules(reader: Pick<typeof db, "select">, localDate: string, owner: SQL, includeHistory = false) {
  const effectiveFrom = sql`greatest(${studentTemplateAssignments.effectiveFrom}, ${classTemplates.effectiveFrom})`;
  const effectiveTo = sql`least(${studentTemplateAssignments.effectiveTo}, ${classTemplates.effectiveTo})`;
  // An ENDED assignment may still be effective on the last day of its date range.
  const currentOrUpcoming = sql<boolean>`(${effectiveTo} is null or ${effectiveTo} >= greatest(${effectiveFrom}, ${localDate}::date))`;
  return reader.select({
    assignmentId: studentTemplateAssignments.id,
    courseName: classTemplates.name,
    isoWeekday: classTemplates.isoWeekday,
    startsAtLocalTime: classTemplates.startsAtLocalTime,
    durationMinutes: classTemplates.durationMinutes,
    effectiveFrom: sql<string>`${effectiveFrom}::text`,
    effectiveTo: sql<string | null>`${effectiveTo}::text`,
    upcoming: sql<boolean>`${effectiveFrom} > ${localDate}::date`,
    courseStatus: classTemplates.status,
    assignmentStatus: studentTemplateAssignments.status,
    currentOrUpcoming,
  }).from(studentTemplateAssignments)
    .innerJoin(studentProfiles, eq(studentProfiles.id, studentTemplateAssignments.studentProfileId))
    .innerJoin(classTemplates, eq(classTemplates.id, studentTemplateAssignments.templateId))
    .where(includeHistory ? owner : and(owner, eq(classTemplates.status, "ACTIVE"), currentOrUpcoming))
    .orderBy(classTemplates.isoWeekday, classTemplates.startsAtLocalTime, classTemplates.name, effectiveFrom, studentTemplateAssignments.id);
}

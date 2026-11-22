import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, gte, ilike, inArray, lt, ne, notExists, or, sql, type SQLWrapper } from "drizzle-orm";
import { DateTime } from "luxon";

import {
  assignStudentTemplateSchema,
  blockCapacitySchema,
  cancelClassSessionSchema,
  cancelReservationSchema,
  cancelSessionEnrollmentSchema,
  cancellationHistorySchema,
  correctAttendanceSchema,
  createClassTemplateSchema,
  createOneOffSessionSchema,
  createStudentProfileSchema,
  createWeeklyCourseSchema,
  detectAbsencesSchema,
  endStudentTemplateAssignmentSchema,
  enrollStudentInSessionSchema,
  generateSessionsSchema,
  ordinaryEnrollmentSchema,
  recordAttendanceSchema,
  releaseCapacityBlockSchema,
  reserveSeatSchema,
  searchSessionEnrollmentStudentsSchema,
  setClassTemplateStatusSchema,
  updateClassSessionSchema,
} from "@/src/application/academic/schemas";
import { assertNoActiveAttendance, findActiveAttendance } from "@/src/application/academic/attendance-records";
import { readCancellationStreak } from "@/src/application/academic/cancellation-sequence-service";
import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import {
  currentClassAttendance, habitualAssignmentExists, historicalClass, reservationHasHabitualAssignment, selectHabitualSchedules, studentClassDetails,
} from "@/src/application/academic/student-class-queries";
import { requireActiveStudentForBooking, requireActiveStudentForCancellation } from "@/src/application/auth/active-student";
import { lockStudentProfile, resolvePendingCancellationCredits, tryGenerateAutoCreditFromCancellation } from "@/src/application/credits/credit-service";
import { cancelRecoveriesForCancelledSession, cancelRecoveryReservation, reserveRecovery } from "@/src/application/recovery/recovery-service";
import { calculateAvailableSpots, getSessionBookingStatus } from "@/src/domain/academic/availability";
import { classifyCancellationTiming, evaluateCancellationSequence, evaluateCancellationTimeline, type HabitualSequenceEvent } from "@/src/domain/academic/cancellation-rules";
import {
  DEFAULT_CLASS_CAPACITY, SESSION_GENERATION_HORIZON_MONTHS, WEEKLY_COURSE_DURATION_MONTHS,
} from "@/src/domain/academic/constants";
import { generateRecurringSessionCandidates } from "@/src/domain/academic/recurrence";
import { resolveLocalDateTime, toUtcDate } from "@/src/domain/time/local-datetime";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { normalizeEmail } from "@/src/domain/auth/email";
import { type UserRole } from "@/src/domain/auth/roles";
import { lockClassSessionForReservation } from "@/src/infrastructure/db/class-reservation-locks";
import { db } from "@/src/infrastructure/db/client";
import {
  findExistingHabitualCapacityConflict, lockTemplateAssignments, readSessionUsage,
  reserveGeneratedSessionHabitualSeats, reserveHabitualSeats,
} from "@/src/infrastructure/db/habitual-reservations.mjs";
import {
  classReservations,
  classSessionEdits,
  classSessions,
  classTemplates,
  creditLedgerMovements,
  reservationAttendanceRecords,
  reservationCancellations,
  sessionCapacityBlocks,
  studentProfiles,
  studentTemplateAssignments,
  users,
} from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type Actor = {
  userId: string;
  role: UserRole;
};

type SessionAvailability = {
  capacity: number;
  confirmedReservations: number;
  blockedSpots: number;
  availableSpots: number;
};

function requireSuperAdmin(actor: Actor): void {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
}

function nowCenterTime(): DateTime {
  return DateTime.now().setZone(CENTER_TIME_ZONE);
}

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QueryExecutor = Pick<TransactionClient, "execute">;
type AcademicRegulation = Awaited<ReturnType<typeof resolveCurrentAcademicRegulation>>;

function resolveConfiguredCapacity(requested: number | undefined, maximum: number): number {
  if (requested !== undefined && requested > maximum) {
    throw new ApplicationError("La capacidad supera el máximo de la normativa vigente.", "regulation_capacity_exceeded", 400, true);
  }
  return requested ?? maximum;
}

function toCenterLocalDate(utcDate: Date): string {
  const localDate = DateTime.fromJSDate(utcDate, { zone: "utc" }).setZone(CENTER_TIME_ZONE).toISODate();
  if (!localDate) {
    throw new ApplicationError("Invalid UTC date for local conversion.", "invalid_local_date", 500, false);
  }
  return localDate;
}

function toMonthRange(localDate: string): { monthStartLocalDate: string; nextMonthStartLocalDate: string } {
  const local = DateTime.fromISO(localDate, { zone: CENTER_TIME_ZONE });
  if (!local.isValid) {
    throw new ApplicationError("Invalid local date.", "invalid_local_date", 500, false);
  }

  return {
    monthStartLocalDate: local.startOf("month").toISODate() ?? localDate,
    nextMonthStartLocalDate: local.startOf("month").plus({ months: 1 }).toISODate() ?? localDate,
  };
}

async function isHabitualReservation(
  tx: TransactionClient,
  input: { studentProfileId: string; templateId: string | null; localDate: string },
): Promise<boolean> {
  if (!input.templateId) return false;
  const { rows: [row] } = await tx.execute<{ habitual: boolean }>(
    sql`select ${habitualAssignmentExists({ ...input, templateId: input.templateId })} as habitual`,
  );
  return row.habitual;
}

async function collectHabitualSequenceEvents(tx: QueryExecutor, studentProfileId: string): Promise<HabitualSequenceEvent[]> {
  const cancellationRows = await tx.execute(sql`
    select
      rc.id,
      rc.cancellation_type,
      rc.meets_seven_day_rule,
      rc.is_habitual_reservation,
      cs.starts_at_utc
    from reservation_cancellations rc
    inner join class_sessions cs on cs.id = rc.class_session_id
    where rc.student_profile_id = ${studentProfileId}
      and rc.decision_source is distinct from 'ADMIN_DECISION'
    order by cs.starts_at_utc asc, rc.cancelled_at asc
  `);

  const attendanceRows = await tx.execute(sql`
    select
      ar.id,
      ar.outcome,
      cs.starts_at_utc,
      (
        cs.template_id is not null and exists (
          select 1
          from student_template_assignments sta
          where sta.student_profile_id = ar.student_profile_id
            and sta.template_id = cs.template_id
            and sta.effective_from <= cs.local_date
            and (sta.effective_to is null or sta.effective_to >= cs.local_date)
        )
      ) as is_habitual_reservation
    from reservation_attendance_records ar
    inner join class_reservations r on r.id = ar.reservation_id
    inner join class_sessions cs on cs.id = ar.class_session_id
    where ar.student_profile_id = ${studentProfileId}
      and ar.superseded_at is null
      and r.origin = 'ORDINARY'
    order by cs.starts_at_utc asc, ar.recorded_at asc
  `);

  const events: HabitualSequenceEvent[] = [];

  for (const row of cancellationRows.rows as Array<{
    id: string;
    cancellation_type: "ON_TIME" | "LATE";
    meets_seven_day_rule: boolean;
    is_habitual_reservation: boolean;
    starts_at_utc: Date;
  }>) {
    events.push({
      eventType: "CANCELLATION",
      id: row.id,
      startsAtUtc: new Date(row.starts_at_utc),
      meetsSevenDayRule: row.meets_seven_day_rule,
      cancellationType: row.cancellation_type,
      isHabitualReservation: row.is_habitual_reservation,
    });
  }

  for (const row of attendanceRows.rows as Array<{
    id: string;
    outcome: "ATTENDED" | "ABSENT";
    starts_at_utc: Date;
    is_habitual_reservation: boolean;
  }>) {
    events.push({
      eventType: "ATTENDANCE",
      id: row.id,
      startsAtUtc: new Date(row.starts_at_utc),
      outcome: row.outcome,
      isHabitualReservation: row.is_habitual_reservation,
    });
  }

  return events.sort((a, b) => a.startsAtUtc.getTime() - b.startsAtUtc.getTime());
}

async function snapshotCancellationSequence(tx: TransactionClient, studentProfileId: string, cancellationId: string) {
  const events = await collectHabitualSequenceEvents(tx, studentProfileId);
  const decisions = evaluateCancellationSequence(events);
  const decision = decisions.find((event) => event.id === cancellationId);
  if (!decision) {
    throw new ApplicationError("Cancellation decision not found.", "missing_cancellation_decision", 500);
  }
  const { sequenceId, sequencePosition, isThirdCancellation, canGenerateCreditCandidate, nonEligibilityReason } = decision;
  let alreadyCredited = false;
  if (canGenerateCreditCandidate) {
    const otherCancellationIds = decisions
      .filter((event) => event.sequenceId === sequenceId && event.id !== cancellationId)
      .map((event) => event.id);
    const [priorGrant] = await tx.select({ id: creditLedgerMovements.id })
      .from(creditLedgerMovements)
      .where(and(
        eq(creditLedgerMovements.studentProfileId, studentProfileId),
        eq(creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
        inArray(creditLedgerMovements.sourceCancellationId, otherCancellationIds),
      ))
      .limit(1);
    alreadyCredited = Boolean(priorGrant);
  }
  await tx.update(reservationCancellations)
    .set({
      sequenceId, sequencePosition, isThirdCancellation,
      canGenerateCreditCandidate: canGenerateCreditCandidate && !alreadyCredited,
      nonEligibilityReason: alreadyCredited ? "SEQUENCE_POSITION" : nonEligibilityReason,
    })
    .where(eq(reservationCancellations.id, cancellationId));
  return alreadyCredited;
}

async function autoReserveSessionsForTemplateAssignment(
  tx: TransactionClient,
  input: {
    studentProfileId: string;
    templateId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  },
  regulation: Awaited<ReturnType<typeof resolveCurrentAcademicRegulation>>,
): Promise<number> {
  const lockedSessionsResult = await tx.execute(sql`
    select id, max_capacity
    from class_sessions
    where template_id = ${input.templateId}
      and status = 'SCHEDULED'
      and local_date >= ${input.effectiveFrom}
      and (${input.effectiveTo}::date is null or local_date <= ${input.effectiveTo})
      and starts_at_utc >= now()
    order by starts_at_utc asc
    for update
  `);

  let createdReservations = 0;

  for (const row of lockedSessionsResult.rows as Array<{ id: string; max_capacity: number }>) {
    const result = await reserveHabitualSeats(tx, {
      classSessionId: row.id,
      capacity: Math.min(row.max_capacity, regulation.maxClassCapacity),
      regulationVersionId: regulation.id,
    }, [input.studentProfileId]);
    createdReservations += result.reserved;
  }

  return createdReservations;
}

export async function createStudentProfile(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = createStudentProfileSchema.parse(input);

  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);

  if (!user) {
    throw new ApplicationError("User not found.", "user_not_found", 404, true);
  }
  if (user.role !== "STUDENT") {
    throw new ApplicationError("Only STUDENT users can have student profiles.", "invalid_user_role", 400, true);
  }

  const profileId = randomUUID();
  await db.insert(studentProfiles).values({
    id: profileId,
    userId: payload.userId,
    firstName: payload.firstName,
    lastName: payload.lastName,
    contactPhone: payload.contactPhone,
    contactEmail: payload.contactEmail,
    adminNotes: payload.adminNotes,
  });

  return { profileId };
}

export async function createClassTemplate(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = createClassTemplateSchema.parse(input);

  if (payload.effectiveTo && payload.effectiveTo < payload.effectiveFrom) {
    throw new ApplicationError("effectiveTo must be greater than or equal to effectiveFrom.", "invalid_date_range", 400, true);
  }

  const regulation = await resolveCurrentAcademicRegulation(db);
  const template = await insertClassTemplate(db, payload, regulation);
  return { templateId: template.id };
}

async function insertClassTemplate(
  writer: Pick<TransactionClient, "insert">,
  payload: ReturnType<typeof createClassTemplateSchema.parse>,
  regulation: AcademicRegulation,
) {
  const [template] = await writer.insert(classTemplates).values({
    ...payload,
    id: randomUUID(),
    maxCapacity: resolveConfiguredCapacity(payload.maxCapacity, regulation.maxClassCapacity),
    regulationVersionId: regulation.id,
    status: "ACTIVE",
  }).returning();
  return template;
}

export async function createWeeklyCourse(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = createWeeklyCourseSchema.parse(input);
  const now = nowCenterTime();
  const firstDay = DateTime.fromISO(payload.firstClassDate, { zone: CENTER_TIME_ZONE });
  // The three-month anniversary is exclusive. Templates store the last valid day inclusive.
  const lastDay = firstDay.plus({ months: WEEKLY_COURSE_DURATION_MONTHS }).minus({ days: 1 }).endOf("day");

  return db.transaction(async (tx) => {
    const regulation = await resolveCurrentAcademicRegulation(tx, now.toJSDate());
    const template = await insertClassTemplate(tx, {
      name: payload.name,
      startsAtLocalTime: payload.startsAtLocalTime,
      durationMinutes: payload.durationMinutes,
      maxCapacity: payload.maxCapacity,
      isoWeekday: firstDay.weekday,
      effectiveFrom: payload.firstClassDate,
      effectiveTo: lastDay.toISODate()!,
    }, regulation);
    const sessions = await materializeTemplateSessions(tx, template, regulation, { now, horizonEnd: lastDay });
    return { templateId: template.id, insertedSessions: sessions.inserted };
  });
}

export async function setClassTemplateStatus(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = setClassTemplateStatusSchema.parse(input);
  await db
    .update(classTemplates)
    .set({
      status: payload.status,
      updatedAt: new Date(),
    })
    .where(eq(classTemplates.id, payload.templateId));
}

export async function createOneOffClassSession(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = createOneOffSessionSchema.parse(input);
  const startLocalDateTime = resolveLocalDateTime({
    localDate: payload.localDate,
    localTime: payload.startsAtLocalTime,
  });
  const endLocalDateTime = startLocalDateTime.plus({ minutes: payload.durationMinutes });

  const classSessionId = randomUUID();
  const regulation = await resolveCurrentAcademicRegulation(db);
  await db.insert(classSessions).values({
    id: classSessionId,
    templateId: null,
    localDate: payload.localDate,
    startsAtUtc: toUtcDate(startLocalDateTime),
    endsAtUtc: toUtcDate(endLocalDateTime),
    status: "SCHEDULED",
    maxCapacity: resolveConfiguredCapacity(payload.maxCapacity, regulation.maxClassCapacity),
    regulationVersionId: regulation.id,
    isManuallyEdited: false,
  });

  return { classSessionId };
}

export async function updateClassSession(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = updateClassSessionSchema.parse(input);
  if (payload.status === "CANCELLED") {
    throw new ApplicationError("Use the administrative cancellation operation.", "use_session_cancellation", 409, true);
  }

  await db.transaction(async (tx) => {
    const sessionRows = await tx.execute(sql`
      select
        id,
        local_date::text as local_date,
        starts_at_utc,
        ends_at_utc,
        status,
        max_capacity
      from class_sessions
      where id = ${payload.classSessionId}
      for update
    `);

    const session = sessionRows.rows[0] as
      | {
          id: string;
          local_date: string;
          starts_at_utc: Date;
          ends_at_utc: Date;
          status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
          max_capacity: number;
        }
      | undefined;

    if (!session) {
      throw new ApplicationError("Class session not found.", "session_not_found", 404, true);
    }

    const editedAt = new Date();
    const regulation = await resolveCurrentAcademicRegulation(tx, editedAt);
    const nextStartsAtUtc = payload.startsAtUtc ?? new Date(session.starts_at_utc);
    const nextEndsAtUtc = payload.endsAtUtc ?? new Date(session.ends_at_utc);
    const nextMaxCapacity = payload.maxCapacity === undefined
      ? session.max_capacity
      : resolveConfiguredCapacity(payload.maxCapacity, regulation.maxClassCapacity);
    const nextStatus = payload.status ?? session.status;
    const nextLocalDate = toCenterLocalDate(nextStartsAtUtc);
    const timeChanged = nextStartsAtUtc.getTime() !== new Date(session.starts_at_utc).getTime()
      || nextEndsAtUtc.getTime() !== new Date(session.ends_at_utc).getTime();

    if (nextEndsAtUtc.getTime() <= nextStartsAtUtc.getTime()) {
      throw new ApplicationError("Class session end time must be after start time.", "invalid_session_time_range", 400, true);
    }

    if (timeChanged) {
      await assertNoActiveAttendance(tx, eq(reservationAttendanceRecords.classSessionId, payload.classSessionId));
    }

    const usage = await readSessionUsage(tx, payload.classSessionId);
    if (usage.confirmedReservations + usage.blockedSpots > nextMaxCapacity) {
      throw new ApplicationError(
        "Reprogramming would exceed session capacity with current reservations and active blocks.",
        "capacity_conflict",
        409,
        true,
      );
    }

    const previousMonth = toMonthRange(session.local_date).monthStartLocalDate;
    const nextMonth = toMonthRange(nextLocalDate).monthStartLocalDate;
    const affectedProfiles = timeChanged || nextLocalDate !== session.local_date
      ? await lockSessionProfiles(tx, payload.classSessionId) : [];

    if (previousMonth !== nextMonth) {
      const range = toMonthRange(nextLocalDate);
      const conflicts = await tx.execute(sql`
        with moving_recoveries as (
          select r.student_profile_id
          from class_reservations r
          where r.class_session_id = ${payload.classSessionId}
            and r.origin = 'MAKEUP'
            and r.status = 'CONFIRMED'
        ),
        target_month_counts as (
          select
            moving.student_profile_id,
            (
              select count(*)::int
              from class_reservations r
              inner join class_sessions s on s.id = r.class_session_id
              where r.origin = 'MAKEUP'
                and r.status = 'CONFIRMED'
                and s.id <> ${payload.classSessionId}
                and s.local_date >= ${range.monthStartLocalDate}
                and s.local_date < ${range.nextMonthStartLocalDate}
                and r.student_profile_id = moving.student_profile_id
            ) as monthly_count
          from moving_recoveries moving
        )
        select student_profile_id
        from target_month_counts
        where monthly_count >= ${regulation.monthlyRecoveries}
      `);

      if (conflicts.rows.length > 0) {
        throw new ApplicationError(
          "Reprogramming would exceed the monthly recovery limit for one or more students.",
          "reprogram_monthly_recovery_limit_conflict",
          409,
          true,
        );
      }
    }

    await tx
      .update(classSessions)
      .set({
        localDate: nextLocalDate,
        startsAtUtc: nextStartsAtUtc,
        endsAtUtc: nextEndsAtUtc,
        maxCapacity: nextMaxCapacity,
        status: nextStatus,
        isManuallyEdited: true,
        updatedAt: editedAt,
      })
      .where(eq(classSessions.id, payload.classSessionId));

    await tx.insert(classSessionEdits).values({
      id: randomUUID(),
      classSessionId: payload.classSessionId,
      regulationVersionId: regulation.id,
      editedByUserId: actor.userId,
      editedAt,
      startsAtUtc: nextStartsAtUtc,
      endsAtUtc: nextEndsAtUtc,
      maxCapacity: nextMaxCapacity,
      status: nextStatus,
    });
    for (const profileId of affectedProfiles) await resolvePendingCancellationCredits(tx, profileId);
  });
}

async function lockSessionProfiles(tx: TransactionClient, sessionId: string): Promise<string[]> {
  const rows = await tx.select({ id: studentProfiles.id }).from(studentProfiles)
    .where(inArray(studentProfiles.id, tx.select({ id: classReservations.studentProfileId }).from(classReservations)
      .where(eq(classReservations.classSessionId, sessionId))))
    .orderBy(studentProfiles.id)
    .for("update");
  return rows.map(({ id }) => id);
}

export async function cancelClassSession(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = cancelClassSessionSchema.parse(input);

  return db.transaction(async (tx) => {
    const now = new Date();
    const regulation = await resolveCurrentAcademicRegulation(tx, now);
    const [session] = await tx.select({ status: classSessions.status }).from(classSessions)
      .where(eq(classSessions.id, payload.classSessionId)).for("update");
    if (session && session.status !== "CANCELLED") {
      await assertNoActiveAttendance(tx, eq(reservationAttendanceRecords.classSessionId, payload.classSessionId));
    }
    const affectedProfiles = session ? await lockSessionProfiles(tx, payload.classSessionId) : [];
    const [cancelledSession] = await tx
      .update(classSessions)
      .set({
        status: "CANCELLED",
        updatedAt: now,
        isManuallyEdited: true,
      })
      .where(and(eq(classSessions.id, payload.classSessionId), ne(classSessions.status, "CANCELLED")))
      .returning({
        startsAtUtc: classSessions.startsAtUtc,
        endsAtUtc: classSessions.endsAtUtc,
        maxCapacity: classSessions.maxCapacity,
      });

    if (cancelledSession) {
      await tx.insert(classSessionEdits).values({
        ...cancelledSession,
        id: randomUUID(),
        classSessionId: payload.classSessionId,
        regulationVersionId: regulation.id,
        editedByUserId: actor.userId,
        editedAt: now,
        status: "CANCELLED",
      });
    }

    await tx
      .update(classReservations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: actor.userId,
        cancellationRegulationVersionId: regulation.id,
        updatedAt: now,
      })
      .where(
        sql`${classReservations.classSessionId} = ${payload.classSessionId}
          and ${classReservations.origin} = 'ORDINARY'
          and ${classReservations.status} = 'CONFIRMED'`,
      );

    const recoveryResult = await cancelRecoveriesForCancelledSession(tx, {
      classSessionId: payload.classSessionId,
      cancelledByUserId: actor.userId,
      reason: "Session cancelled by administration",
      cancelledAt: now,
      regulationVersionId: regulation.id,
    });
    for (const profileId of affectedProfiles) await resolvePendingCancellationCredits(tx, profileId);

    return {
      classSessionId: payload.classSessionId,
      cancelledRecoveries: recoveryResult.cancelledRecoveries,
      refundedRecoveries: recoveryResult.refundsCreated,
    };
  });
}

export async function assignStudentToTemplate(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  return createHabitualAssignment(assignStudentTemplateSchema.parse(input));
}

// Start dates are the only dates on which the number of simultaneous enrollments can increase.
async function assertHabitualEnrollmentCapacity(
  tx: TransactionClient,
  input: { templateId: string; studentProfileId: string; effectiveFrom: string; effectiveTo?: string | null },
) {
  const conflict = await tx.execute(sql`
    with course_window as (
      select greatest(effective_from, ${input.effectiveFrom}::date) as first_day,
        least(effective_to, ${input.effectiveTo ?? null}::date) as last_day
      from class_templates where id = ${input.templateId}
    ), checkpoints as (
      select first_day as day from course_window
      union
      select a.effective_from from student_template_assignments a cross join course_window w
      where a.template_id = ${input.templateId} and a.effective_from > w.first_day
    )
    select 1 from checkpoints c cross join course_window w
    where (w.last_day is null or c.day <= w.last_day)
      and (
        select count(distinct a.student_profile_id)
        from student_template_assignments a
        join student_profiles p on p.id = a.student_profile_id
        join users u on u.id = p.user_id
        where a.template_id = ${input.templateId}
          and a.student_profile_id <> ${input.studentProfileId}
          and a.effective_from <= c.day and (a.effective_to is null or a.effective_to >= c.day)
          and (u.status = 'ACTIVE' or c.day < (u.deactivated_at at time zone ${CENTER_TIME_ZONE})::date)
      ) >= ${DEFAULT_CLASS_CAPACITY}
    limit 1
  `);
  if (conflict.rows.length) {
    throw new ApplicationError("El curso ya tiene 12 alumnos inscritos en el periodo solicitado.", "course_enrollment_full", 409, true);
  }
}

async function createHabitualAssignment(
  payload: ReturnType<typeof assignStudentTemplateSchema.parse>,
  onlyOpenCourse = false,
) {
  if (payload.effectiveTo && payload.effectiveTo < payload.effectiveFrom) {
    throw new ApplicationError("effectiveTo must be greater than or equal to effectiveFrom.", "invalid_date_range", 400, true);
  }

  return db.transaction(async (tx) => {
    await requireActiveStudentForBooking(tx, payload.studentProfileId);
    await lockTemplateAssignments(tx, payload.templateId);
    if (onlyOpenCourse) {
      const [template] = await tx.select({
        status: classTemplates.status, effectiveFrom: classTemplates.effectiveFrom, effectiveTo: classTemplates.effectiveTo,
      }).from(classTemplates).where(eq(classTemplates.id, payload.templateId));
      if (!template || template.status !== "ACTIVE" || (template.effectiveTo && template.effectiveTo < payload.effectiveFrom)) {
        throw new ApplicationError("El curso no está abierto a inscripciones.", "course_not_open", 409, true);
      }
      if (payload.effectiveFrom < template.effectiveFrom) {
        payload = { ...payload, effectiveFrom: template.effectiveFrom };
      }
    }
    await assertHabitualEnrollmentCapacity(tx, payload);
    const regulation = await resolveCurrentAcademicRegulation(tx);
    const assignmentId = randomUUID();
    await tx.insert(studentTemplateAssignments).values({
      id: assignmentId,
      studentProfileId: payload.studentProfileId,
      templateId: payload.templateId,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: payload.effectiveTo ?? null,
      status: payload.effectiveTo ? "ENDED" : "ACTIVE",
    });

    const autoReservedReservationCount = await autoReserveSessionsForTemplateAssignment(tx, {
      studentProfileId: payload.studentProfileId,
      templateId: payload.templateId,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: payload.effectiveTo ?? null,
    }, regulation);

    return { assignmentId, autoReservedReservationCount };
  });
}

export async function enrollStudentInAcademicOffering(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = ordinaryEnrollmentSchema.parse(input);
  if (payload.targetType === "weekly") {
    const result = await createHabitualAssignment({
      studentProfileId: payload.studentProfileId,
      templateId: payload.targetId,
      effectiveFrom: nowCenterTime().toISODate()!,
    }, true);
    return { reservedSessions: result.autoReservedReservationCount };
  }

  await createReservationTransaction(payload.targetId, payload.studentProfileId, { mode: "one-off" });
  return { reservedSessions: 1 };
}

export async function endStudentTemplateAssignment(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = endStudentTemplateAssignmentSchema.parse(input);

  await db.transaction(async (tx) => {
    const [assignment] = await tx.select({
      templateId: studentTemplateAssignments.templateId,
      studentProfileId: studentTemplateAssignments.studentProfileId,
    })
      .from(studentTemplateAssignments)
      .where(eq(studentTemplateAssignments.id, payload.assignmentId));
    if (!assignment) return;
    await requireActiveStudentForBooking(tx, assignment.studentProfileId);
    await lockTemplateAssignments(tx, assignment.templateId);
    const [current] = await tx.select().from(studentTemplateAssignments)
      .where(eq(studentTemplateAssignments.id, payload.assignmentId));
    if (!current) return;
    const effectiveTo = payload.effectiveTo ?? nowCenterTime().toISODate()!;
    if (current.effectiveTo && current.effectiveTo < effectiveTo) {
      const nextDay = DateTime.fromISO(current.effectiveTo, { zone: CENTER_TIME_ZONE }).plus({ days: 1 }).toISODate()!;
      await assertHabitualEnrollmentCapacity(tx, {
        ...current,
        effectiveFrom: nextDay < current.effectiveFrom ? current.effectiveFrom : nextDay,
        effectiveTo,
      });
    }
    await tx.update(studentTemplateAssignments)
      .set({
        effectiveTo,
        status: "ENDED",
        updatedAt: new Date(),
      })
      .where(eq(studentTemplateAssignments.id, payload.assignmentId));
  });
}

async function lockCapacitySession(tx: TransactionClient, classSessionId: string) {
  const [session] = await tx.select({
    templateId: classSessions.templateId,
    maxCapacity: classSessions.maxCapacity,
    sessionStatus: classSessions.status,
    startsAtUtc: classSessions.startsAtUtc,
    endsAtUtc: classSessions.endsAtUtc,
  }).from(classSessions).where(eq(classSessions.id, classSessionId)).for("update");
  if (!session) {
    throw new ApplicationError("Class session not found.", "session_not_found", 404, true);
  }
  return session;
}

export async function addSessionCapacityBlock(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = blockCapacitySchema.parse(input);
  const conflict = () => new ApplicationError("El identificador ya corresponde a otro bloqueo.", "block_id_conflict", 409, true);

  return db.transaction(async (tx) => {
    const session = await lockCapacitySession(tx, payload.classSessionId);
    const [existing] = await tx.select().from(sessionCapacityBlocks).where(eq(sessionCapacityBlocks.id, payload.blockId));
    if (existing) {
      if (existing.classSessionId !== payload.classSessionId || existing.blockedSpots !== payload.blockedSpots
        || existing.reason !== payload.reason || existing.blockedByUserId !== actor.userId) {
        throw conflict();
      }
      return { blockId: existing.id, created: false };
    }

    const now = new Date();
    if (getSessionBookingStatus(session, now) !== "UPCOMING") {
      throw new ApplicationError("Solo se pueden bloquear plazas en sesiones futuras y programadas.", "session_not_reservable", 409, true);
    }
    const regulation = await resolveCurrentAcademicRegulation(tx, now);
    const capacity = Math.min(session.maxCapacity, regulation.maxClassCapacity);
    const usage = await readSessionUsage(tx, payload.classSessionId);
    if (payload.blockedSpots > calculateAvailableSpots({ ...usage, capacity })) {
      throw new ApplicationError("El bloqueo supera las plazas disponibles.", "capacity_conflict", 409, true);
    }

    const [created] = await tx.insert(sessionCapacityBlocks).values({
      id: payload.blockId,
      classSessionId: payload.classSessionId,
      blockedSpots: payload.blockedSpots,
      reason: payload.reason,
      blockedByUserId: actor.userId,
      regulationVersionId: regulation.id,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: sessionCapacityBlocks.id }).returning({ id: sessionCapacityBlocks.id });
    if (!created) throw conflict();
    return { blockId: created.id, created: true };
  });
}

export async function releaseSessionCapacityBlock(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = releaseCapacityBlockSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockCapacitySession(tx, payload.classSessionId);
    const scope = and(eq(sessionCapacityBlocks.id, payload.blockId), eq(sessionCapacityBlocks.classSessionId, payload.classSessionId));
    const [block] = await tx.select({ isActive: sessionCapacityBlocks.isActive }).from(sessionCapacityBlocks).where(scope);
    if (!block) {
      throw new ApplicationError("El bloqueo no existe en esta sesión.", "capacity_block_not_found", 404, true);
    }
    if (!block.isActive) return { blockId: payload.blockId, released: false };

    const now = new Date();
    await tx.update(sessionCapacityBlocks).set({
      isActive: false,
      releasedByUserId: actor.userId,
      releasedAt: now,
      releaseReason: payload.reason,
      updatedAt: now,
    }).where(scope);
    return { blockId: payload.blockId, released: true };
  });
}

export async function getClassSessionAvailability(classSessionId: string): Promise<SessionAvailability> {
  const [session] = await db
    .select({
      id: classSessions.id,
      maxCapacity: classSessions.maxCapacity,
      status: classSessions.status,
    })
    .from(classSessions)
    .where(eq(classSessions.id, classSessionId))
    .limit(1);

  if (!session) {
    throw new ApplicationError("Class session not found.", "session_not_found", 404, true);
  }

  const regulation = await resolveCurrentAcademicRegulation(db);
  const capacity = Math.min(session.maxCapacity, regulation.maxClassCapacity);
  const { confirmedReservations, blockedSpots } = await readSessionUsage(db, classSessionId);
  const availableSpots = calculateAvailableSpots({
    capacity,
    confirmedReservations,
    blockedSpots,
  });

  return {
    capacity,
    confirmedReservations,
    blockedSpots,
    availableSpots,
  };
}

export async function createReservation(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = reserveSeatSchema.parse(input);
  if (payload.origin === "MAKEUP") {
    const { reservationId } = await reserveRecovery(actor, { classSessionId: payload.classSessionId }, payload.studentProfileId);
    return { reservationId };
  }
  const { reservationId } = await createReservationTransaction(payload.classSessionId, payload.studentProfileId);
  return { reservationId };
}

export async function createReservationForCurrentStudent(actor: Actor, classSessionId: string) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }

  const [profile] = await db
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, actor.userId))
    .limit(1);

  if (!profile) {
    throw new ApplicationError("Student profile not found.", "student_profile_not_found", 404, true);
  }

  const { reservationId } = await createReservationTransaction(classSessionId, profile.id);
  return { reservationId };
}

function confirmedSessionReservation(classSessionId: string, studentProfileId: string | SQLWrapper) {
  return and(
    eq(classReservations.classSessionId, classSessionId),
    eq(classReservations.studentProfileId, studentProfileId),
    eq(classReservations.status, "CONFIRMED"),
  );
}

export async function searchSessionEnrollmentStudents(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const { classSessionId, query } = searchSessionEnrollmentStudentsSchema.parse(input);
  const prefix = `${query.replace(/[\\%_]/g, "\\$&")}%`;
  const { firstName, lastName } = studentProfiles;
  const pageSize = 15;
  const matches = await db.select({ id: studentProfiles.id, firstName, lastName, email: users.email })
    .from(studentProfiles)
    .innerJoin(users, eq(studentProfiles.userId, users.id))
    .where(and(
      eq(users.role, "STUDENT"),
      eq(users.status, "ACTIVE"),
      or(
        ilike(firstName, prefix), ilike(lastName, prefix),
        ilike(sql`${firstName} || ' ' || ${lastName}`, prefix),
        ilike(sql`${lastName} || ' ' || ${firstName}`, prefix),
        eq(users.emailNormalized, normalizeEmail(query)),
      ),
      notExists(db.select({ id: classReservations.id }).from(classReservations)
        .where(confirmedSessionReservation(classSessionId, studentProfiles.id))),
    ))
    .orderBy(lastName, firstName, studentProfiles.id)
    .limit(pageSize + 1);

  return {
    hasMore: matches.length > pageSize,
    students: matches.slice(0, pageSize).map((student) => {
      const name = `${student.firstName} ${student.lastName}`;
      const needsEmail = matches.some((other) => other.id !== student.id
        && `${other.firstName} ${other.lastName}`.toLowerCase() === name.toLowerCase());
      return { id: student.id, label: needsEmail ? `${name} (${student.email})` : name };
    }),
  };
}

export async function enrollStudentInSession(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const { classSessionId, studentProfileId, reservationId } = enrollStudentInSessionSchema.parse(input);
  return createReservationTransaction(classSessionId, studentProfileId, {
    mode: "session-detail",
    reservationId,
    createdByUserId: actor.userId,
  });
}

type OrdinaryReservationContext = { mode: "one-off" } | {
  mode: "session-detail";
  reservationId: string;
  createdByUserId: string;
};

async function createReservationTransaction(
  classSessionId: string,
  studentProfileId: string,
  context?: OrdinaryReservationContext,
) {
  return db.transaction(async (tx) => {
    await requireActiveStudentForBooking(tx, studentProfileId);
    const session = await lockCapacitySession(tx, classSessionId);
    const detail = context?.mode === "session-detail" ? context : undefined;
    const reservationId = detail?.reservationId ?? randomUUID();
    if (detail) {
      const [existing] = await tx.select().from(classReservations).where(eq(classReservations.id, reservationId));
      if (existing) {
        if (existing.classSessionId !== classSessionId || existing.studentProfileId !== studentProfileId
          || existing.createdByUserId !== detail.createdByUserId || existing.origin !== "ORDINARY") {
          throw new ApplicationError("Reservation request ID is already in use.", "enrollment_id_conflict", 409, true);
        }
        if (existing.status !== "CONFIRMED") {
          throw new ApplicationError("This reservation has been cancelled.", "enrollment_already_cancelled", 409, true);
        }
        return { reservationId, created: false };
      }
    }

    const now = new Date();
    if (context?.mode === "one-off" && (session.templateId !== null || session.startsAtUtc <= now)) {
      throw new ApplicationError("Selecciona una clase única futura.", "invalid_one_off_enrollment", 409, true);
    }
    if (session.sessionStatus !== "SCHEDULED" || (detail && getSessionBookingStatus(session, now) !== "UPCOMING")) {
      throw new ApplicationError("Class session is not open for reservation.", "session_not_reservable", 409, true);
    }

    if (detail) {
      const [confirmed] = await tx.select({ id: classReservations.id }).from(classReservations)
        .where(confirmedSessionReservation(classSessionId, studentProfileId));
      if (confirmed) {
        throw new ApplicationError("A confirmed reservation already exists.", "reservation_already_confirmed", 409, true);
      }
    }

    const regulation = await resolveCurrentAcademicRegulation(tx, now);
    const usage = await readSessionUsage(tx, classSessionId);
    if (calculateAvailableSpots({ ...usage, capacity: Math.min(session.maxCapacity, regulation.maxClassCapacity) }) === 0) {
      throw new ApplicationError("No spots available.", "no_spots_available", 409, true);
    }

    const [created] = await tx.insert(classReservations).values({
      id: reservationId,
      classSessionId,
      studentProfileId,
      status: "CONFIRMED",
      origin: "ORDINARY",
      regulationVersionId: regulation.id,
      createdByUserId: detail?.createdByUserId,
      createdAt: detail ? now : undefined,
      updatedAt: detail ? now : undefined,
    }).onConflictDoNothing({ target: classReservations.id }).returning({ id: classReservations.id });
    if (!created) {
      throw new ApplicationError("Reservation request ID is already in use.", "enrollment_id_conflict", 409, true);
    }

    return { reservationId, created: true };
  });
}

type LockedReservation = {
  reservationId: string;
  reservationStatus: "CONFIRMED" | "CANCELLED";
  reservationOrigin: "ORDINARY" | "MAKEUP";
  studentProfileId: string;
  classSessionId: string;
  classStatus: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  classStartsAtUtc: Date;
  classEndsAtUtc: Date;
  classLocalDate: string;
  templateId: string | null;
};

async function lockReservationForMutation(tx: TransactionClient, reservationId: string): Promise<LockedReservation> {
  await lockClassSessionForReservation(tx, reservationId);
  const rows = await tx.execute(sql`
    select
      r.id as reservation_id,
      r.status as reservation_status,
      r.origin as reservation_origin,
      r.student_profile_id,
      r.class_session_id,
      s.status as class_status,
      s.starts_at_utc as class_starts_at_utc,
      s.ends_at_utc as class_ends_at_utc,
      s.local_date::text as class_local_date,
      s.template_id
    from class_reservations r
    inner join class_sessions s on s.id = r.class_session_id
    where r.id = ${reservationId}
    for update of r
  `);

  const row = rows.rows[0] as
    | {
        reservation_id: string;
        reservation_status: "CONFIRMED" | "CANCELLED";
        reservation_origin: "ORDINARY" | "MAKEUP";
        student_profile_id: string;
        class_session_id: string;
        class_status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
        class_starts_at_utc: Date;
        class_ends_at_utc: Date;
        class_local_date: string;
        template_id: string | null;
      }
    | undefined;

  if (!row) {
    throw new ApplicationError("Reservation not found.", "reservation_not_found", 404, true);
  }

  return {
    reservationId: row.reservation_id,
    reservationStatus: row.reservation_status,
    reservationOrigin: row.reservation_origin,
    studentProfileId: row.student_profile_id,
    classSessionId: row.class_session_id,
    classStatus: row.class_status,
    classStartsAtUtc: new Date(row.class_starts_at_utc),
    classEndsAtUtc: new Date(row.class_ends_at_utc),
    classLocalDate: row.class_local_date,
    templateId: row.template_id,
  };
}

export async function cancelReservation(actor: Actor, input: unknown) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
  const payload = cancelReservationSchema.parse(input);
  const [reservation] = await db.select({ origin: classReservations.origin }).from(classReservations)
    .where(eq(classReservations.id, payload.reservationId));
  if (reservation?.origin === "MAKEUP") {
    return cancelRecoveryReservation(actor, input);
  }
  return cancelOrdinaryReservation(actor, payload.reservationId);
}

export async function cancelSessionEnrollment(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const decision = cancelSessionEnrollmentSchema.parse(input);
  return cancelOrdinaryReservation(actor, decision.reservationId, decision);
}

async function cancelOrdinaryReservation(
  actor: Actor,
  reservationId: string,
  decision?: ReturnType<typeof cancelSessionEnrollmentSchema.parse>,
) {
  return db.transaction(async (tx) => {
    const studentProfileId = decision ? undefined : await requireActiveStudentForCancellation(tx, actor.userId);
    const lockedReservation = await lockReservationForMutation(tx, reservationId);

    if (decision) {
      if (lockedReservation.classSessionId !== decision.classSessionId) {
        throw new ApplicationError("Reservation not found in this session.", "reservation_not_found", 404, true);
      }
      if (lockedReservation.reservationOrigin !== "ORDINARY") {
        throw new ApplicationError("Only ordinary reservations can be cancelled here.", "reservation_not_ordinary", 409, true);
      }
      const [existing] = await tx.select().from(reservationCancellations)
        .where(eq(reservationCancellations.reservationId, reservationId));
      if (existing) {
        if (lockedReservation.reservationStatus === "CANCELLED" && existing.id === decision.cancellationId
          && existing.decisionSource === "ADMIN_DECISION" && existing.cancelledByUserId === actor.userId
          && existing.administrativeReason === decision.reason) {
          return { cancellationId: existing.id, created: false, autoCreditGenerated: false };
        }
        throw new ApplicationError("A cancellation already exists.", "reservation_already_cancelled", 409, true);
      }
    } else if (studentProfileId !== lockedReservation.studentProfileId) {
      throw new ApplicationError("Forbidden", "forbidden", 403, true);
    }

    if (lockedReservation.reservationStatus !== "CONFIRMED") {
      throw new ApplicationError("Reservation already cancelled.", "reservation_not_confirmed", 409, true);
    }
    if (lockedReservation.classStatus !== "SCHEDULED") {
      throw new ApplicationError("Class session does not allow cancellation.", "session_not_cancellable", 409, true);
    }
    await assertNoActiveAttendance(tx, eq(reservationAttendanceRecords.reservationId, lockedReservation.reservationId));

    await lockStudentProfile(tx, lockedReservation.studentProfileId);
    const cancelledAt = new Date();
    if (decision && lockedReservation.classStartsAtUtc <= cancelledAt) {
      throw new ApplicationError("Only future reservations can be cancelled here.", "session_not_cancellable", 409, true);
    }
    const regulation = await resolveCurrentAcademicRegulation(tx, cancelledAt);
    const timing = classifyCancellationTiming(cancelledAt, lockedReservation.classStartsAtUtc, regulation.cancellationNoticeDays);
    const isHabitual = await isHabitualReservation(tx, {
      studentProfileId: lockedReservation.studentProfileId,
      templateId: lockedReservation.templateId,
      localDate: lockedReservation.classLocalDate,
    });

    await tx
      .update(classReservations)
      .set({
        status: "CANCELLED",
        cancelledAt,
        cancelledByUserId: actor.userId,
        cancellationRegulationVersionId: regulation.id,
        updatedAt: cancelledAt,
      })
      .where(eq(classReservations.id, lockedReservation.reservationId));

    const cancellationId = decision?.cancellationId ?? randomUUID();
    const revisedRule = regulation.maxEligibleConsecutiveCancellations !== null;
    const [created] = await tx.insert(reservationCancellations).values({
      id: cancellationId,
      reservationId: lockedReservation.reservationId,
      studentProfileId: lockedReservation.studentProfileId,
      classSessionId: lockedReservation.classSessionId,
      cancelledByUserId: actor.userId,
      cancelledAt,
      decisionSource: decision ? "ADMIN_DECISION" : "STUDENT_REQUEST",
      administrativeReason: decision?.reason,
      regulationVersionId: regulation.id,
      cancellationType: timing.type,
      hoursBeforeStart: timing.hoursBeforeStart,
      meetsSevenDayRule: timing.meetsSevenDayRule,
      isHabitualReservation: isHabitual,
      sequenceId: null,
      sequencePosition: null,
      sequencePending: revisedRule && !decision && isHabitual,
      creditResolution: revisedRule && !decision && !isHabitual ? "NOT_ELIGIBLE" : null,
      isThirdCancellation: false,
      canGenerateCreditCandidate: false,
      nonEligibilityReason: revisedRule && !decision && !isHabitual ? "NON_HABITUAL" : null,
    }).onConflictDoNothing({ target: reservationCancellations.id }).returning({ id: reservationCancellations.id });
    if (!created) {
      throw new ApplicationError("Cancellation request ID is already in use.", "cancellation_id_conflict", 409, true);
    }
    if (decision) {
      await resolvePendingCancellationCredits(tx, lockedReservation.studentProfileId);
      return { cancellationId, created: true, autoCreditGenerated: false };
    }

    const autoCredit = revisedRule
      ? (await resolvePendingCancellationCredits(tx, lockedReservation.studentProfileId)).get(cancellationId)
        ?? { created: false, reason: isHabitual && timing.meetsSevenDayRule ? "PENDING" as const : "NOT_ELIGIBLE" as const }
      : await resolveLegacyCancellationCredit(tx, lockedReservation.studentProfileId, cancellationId);

    return {
      cancellationId,
      created: true,
      cancellationType: timing.type,
      meetsSevenDayRule: timing.meetsSevenDayRule,
      autoCreditGenerated: autoCredit.created,
      autoCreditSkippedReason: autoCredit.reason ?? null,
      regulationVersionId: regulation.id,
    };
  });
}

async function resolveLegacyCancellationCredit(tx: TransactionClient, studentProfileId: string, cancellationId: string) {
  const alreadyCredited = await snapshotCancellationSequence(tx, studentProfileId, cancellationId);
  return alreadyCredited
    ? { created: false, reason: "SEQUENCE_ALREADY_CREDITED" as const }
    : tryGenerateAutoCreditFromCancellation(tx, cancellationId);
}

async function lockAttendanceTarget(tx: TransactionClient, payload: { reservationId: string; classSessionId: string }) {
  const reservation = await lockReservationForMutation(tx, payload.reservationId);
  if (reservation.classSessionId !== payload.classSessionId) {
    throw new ApplicationError("Reservation not found in this session.", "reservation_not_found", 404, true);
  }
  if (reservation.classStatus === "CANCELLED") {
    throw new ApplicationError("Cannot record attendance for a cancelled session.", "session_cancelled", 409, true);
  }
  if (reservation.reservationStatus !== "CONFIRMED") {
    throw new ApplicationError("Cannot record attendance for a cancelled reservation.", "reservation_not_confirmed", 409, true);
  }
  await lockStudentProfile(tx, reservation.studentProfileId);
  const recordedAt = new Date();
  if (recordedAt < reservation.classEndsAtUtc) {
    throw new ApplicationError("Attendance can only be recorded after the session ends.", "session_not_ended", 409, true);
  }

  const [existingCancellation] = await tx.select({ id: reservationCancellations.id })
    .from(reservationCancellations)
    .where(eq(reservationCancellations.reservationId, reservation.reservationId))
    .limit(1);
  if (existingCancellation) {
    throw new ApplicationError("Cannot record attendance for a cancelled reservation.", "reservation_cancelled", 409, true);
  }

  return { reservation, recordedAt };
}

export async function recordAttendance(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = recordAttendanceSchema.parse(input);

  return db.transaction(async (tx) => {
    const { reservation, recordedAt } = await lockAttendanceTarget(tx, payload);
    const activeRecord = await findActiveAttendance(tx, eq(reservationAttendanceRecords.reservationId, reservation.reservationId));

    if (activeRecord && activeRecord.outcome === payload.outcome) {
      await resolvePendingCancellationCredits(tx, reservation.studentProfileId);
      return { attendanceRecordId: activeRecord.id, updated: false };
    }

    if (activeRecord) {
      throw new ApplicationError("Use the attendance correction operation to change the outcome.", "attendance_already_recorded", 409, true);
    }

    const regulation = await resolveCurrentAcademicRegulation(tx, recordedAt);
    const attendanceRecordId = randomUUID();
    await tx.insert(reservationAttendanceRecords).values({
      id: attendanceRecordId,
      reservationId: reservation.reservationId,
      studentProfileId: reservation.studentProfileId,
      classSessionId: reservation.classSessionId,
      outcome: payload.outcome,
      source: "MANUAL",
      recordedByUserId: actor.userId,
      recordedAt,
      regulationVersionId: regulation.id,
      correctionReason: null,
      correctedFromRecordId: null,
      supersededAt: null,
    });
    await resolvePendingCancellationCredits(tx, reservation.studentProfileId);

    return { attendanceRecordId, updated: true };
  });
}

export async function correctAttendance(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = correctAttendanceSchema.parse(input);

  return db.transaction(async (tx) => {
    const { reservation, recordedAt } = await lockAttendanceTarget(tx, payload);
    const activeRecord = await findActiveAttendance(tx, eq(reservationAttendanceRecords.reservationId, reservation.reservationId));

    if (!activeRecord) {
      throw new ApplicationError("No attendance record to correct.", "attendance_not_found", 404, true);
    }
    if (activeRecord.outcome === payload.outcome) {
      throw new ApplicationError("Correction must change the outcome.", "attendance_same_outcome", 400, true);
    }

    await tx
      .update(reservationAttendanceRecords)
      .set({
        supersededAt: recordedAt,
        updatedAt: recordedAt,
      })
      .where(eq(reservationAttendanceRecords.id, activeRecord.id));

    const regulation = await resolveCurrentAcademicRegulation(tx, recordedAt);
    const attendanceRecordId = randomUUID();
    await tx.insert(reservationAttendanceRecords).values({
      id: attendanceRecordId,
      reservationId: reservation.reservationId,
      studentProfileId: reservation.studentProfileId,
      classSessionId: reservation.classSessionId,
      outcome: payload.outcome,
      source: "MANUAL",
      recordedByUserId: actor.userId,
      recordedAt,
      regulationVersionId: regulation.id,
      correctionReason: payload.reason,
      correctedFromRecordId: activeRecord.id,
      supersededAt: null,
    });
    await resolvePendingCancellationCredits(tx, reservation.studentProfileId);

    return { attendanceRecordId };
  });
}

export async function detectAbsences(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = detectAbsencesSchema.parse(input);
  const now = new Date();
  const referenceTime = payload.referenceTimeUtc && payload.referenceTimeUtc < now ? payload.referenceTimeUtc : now;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(903000042)`);

    const pendingReservations = sql`
      from class_reservations r
      left join reservation_cancellations rc on rc.reservation_id = r.id
      left join reservation_attendance_records ar on ar.reservation_id = r.id and ar.superseded_at is null
      where r.status = 'CONFIRMED'
        and r.class_session_id = s.id
        and rc.id is null
        and ar.id is null`;
    const finishedSession = sql`s.status != 'CANCELLED' and s.ends_at_utc <= ${referenceTime}`;
    const locked = await tx.execute(sql`
      select s.id from class_sessions s
      where ${finishedSession} and exists (select 1 ${pendingReservations})
      order by s.id
      for no key update of s
    `);
    if (!locked.rows.length) return { createdAbsences: 0, affectedProfiles: 0 };

    // Re-read the reservations after acquiring the same session locks as manual mutations.
    const sessionIds = locked.rows.map(({ id }) => sql`${id}`);
    const candidateRows = await tx.execute(sql`
      select r.id as reservation_id, r.student_profile_id, r.class_session_id
      from class_sessions s
      join lateral (select r.id, r.student_profile_id, r.class_session_id ${pendingReservations}) r on true
      where ${finishedSession}
        and s.id in (${sql.join(sessionIds, sql`, `)})
    `);

    const candidates = candidateRows.rows as Array<{
      reservation_id: string;
      student_profile_id: string;
      class_session_id: string;
    }>;

    if (candidates.length === 0) {
      return {
        createdAbsences: 0,
        affectedProfiles: 0,
      };
    }

    const regulation = await resolveCurrentAcademicRegulation(tx, referenceTime);
    const profiles = [...new Set(candidates.map(({ student_profile_id }) => student_profile_id))].sort();
    for (const profileId of profiles) await lockStudentProfile(tx, profileId);
    const insertedRows = await tx
      .insert(reservationAttendanceRecords)
      .values(
        candidates.map((candidate) => ({
          id: randomUUID(),
          reservationId: candidate.reservation_id,
          studentProfileId: candidate.student_profile_id,
          classSessionId: candidate.class_session_id,
          outcome: "ABSENT" as const,
          source: "AUTO" as const,
          recordedByUserId: null,
          recordedAt: referenceTime,
          regulationVersionId: regulation.id,
          correctionReason: null,
          correctedFromRecordId: null,
          supersededAt: null,
        })),
      )
      .onConflictDoNothing()
      .returning({ studentProfileId: reservationAttendanceRecords.studentProfileId });

    const affectedProfiles = Array.from(
      new Set(insertedRows.map((row) => row.studentProfileId)),
    );
    for (const profileId of affectedProfiles) await resolvePendingCancellationCredits(tx, profileId);

    return {
      createdAbsences: insertedRows.length,
      affectedProfiles: affectedProfiles.length,
    };
  });
}

function reservationOwnerIsStudent(actor: Actor) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
  return eq(studentProfiles.userId, actor.userId);
}

function confirmedReservationsForStudent(actor: Actor) {
  return and(reservationOwnerIsStudent(actor), eq(classReservations.status, "CONFIRMED"));
}

export async function listUpcomingOrdinaryReservations(actor: Actor) {
  return db.select({
    reservationId: classReservations.id,
    localDate: classSessions.localDate,
    startsAtUtc: classSessions.startsAtUtc,
  }).from(classReservations)
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .innerJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .where(and(
      confirmedReservationsForStudent(actor),
      eq(classReservations.origin, "ORDINARY"),
      eq(classSessions.status, "SCHEDULED"),
      gt(classSessions.startsAtUtc, new Date()),
    ))
    .orderBy(classSessions.startsAtUtc, classReservations.id);
}

export async function listStudentCalendarReservations(actor: Actor, start: Date, end: Date) {
  return db.select({ ...studentClassDetails, habitual: reservationHasHabitualAssignment }).from(classReservations)
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .innerJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .leftJoin(classTemplates, eq(classTemplates.id, classSessions.templateId))
    .where(and(
      confirmedReservationsForStudent(actor),
      ne(classSessions.status, "CANCELLED"),
      gte(classSessions.startsAtUtc, start),
      lt(classSessions.startsAtUtc, end),
    ))
    .orderBy(classSessions.startsAtUtc, classReservations.id);
}

export async function listStudentClassHistory(actor: Actor, now: Date) {
  const historical = historicalClass(now);
  const rows = await db.select({
    ...studentClassDetails,
    localDate: classSessions.localDate,
    status: classReservations.status,
    cancellationType: reservationCancellations.cancellationType,
    cancellationSource: reservationCancellations.decisionSource,
    sequencePending: reservationCancellations.sequencePending,
    attendanceOutcome: reservationAttendanceRecords.outcome,
    habitual: sql<boolean>`coalesce(${reservationCancellations.isHabitualReservation}, ${reservationHasHabitualAssignment})`,
    historical: sql<boolean>`${historical}`,
  }).from(classReservations)
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .innerJoin(studentProfiles, eq(studentProfiles.id, classReservations.studentProfileId))
    .leftJoin(classTemplates, eq(classTemplates.id, classSessions.templateId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.reservationId, classReservations.id))
    .leftJoin(reservationAttendanceRecords, currentClassAttendance)
    .where(and(reservationOwnerIsStudent(actor), or(historical, eq(classReservations.origin, "MAKEUP"))))
    .orderBy(desc(classSessions.startsAtUtc), desc(classReservations.id));

  return {
    history: rows.filter((row) => row.historical),
    pendingRecoveries: rows.filter((row) => !row.historical).reverse(),
  };
}

export async function listStudentHabitualSchedules(actor: Actor, localDate: string) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
  const schedules = await selectHabitualSchedules(db, localDate, eq(studentProfiles.userId, actor.userId));
  return schedules.map(({ assignmentId, courseName, isoWeekday, startsAtLocalTime, durationMinutes, effectiveFrom, effectiveTo, upcoming }) =>
    ({ assignmentId, courseName, isoWeekday, startsAtLocalTime, durationMinutes, effectiveFrom, effectiveTo, upcoming }));
}

export async function getStudentActivityHistory(actor: Actor, input?: unknown) {
  const payload = cancellationHistorySchema.parse(input ?? {});
  let studentProfileId = payload.studentProfileId;

  if (actor.role === "STUDENT") {
    const [profile] = await db
      .select({ id: studentProfiles.id })
      .from(studentProfiles)
      .where(eq(studentProfiles.userId, actor.userId))
      .limit(1);

    if (!profile) {
      throw new ApplicationError("Student profile not found.", "student_profile_not_found", 404, true);
    }
    studentProfileId = profile.id;
  } else {
    requireSuperAdmin(actor);
    if (!studentProfileId) {
      throw new ApplicationError("studentProfileId is required for admin queries.", "student_profile_required", 400, true);
    }
  }

  const cancellations = await db
    .select({
      id: reservationCancellations.id,
      classSessionId: reservationCancellations.classSessionId,
      cancelledAt: reservationCancellations.cancelledAt,
      regulationVersionId: reservationCancellations.regulationVersionId,
      cancellationType: reservationCancellations.cancellationType,
      cancellationSource: reservationCancellations.decisionSource,
      sequencePending: reservationCancellations.sequencePending,
      creditResolution: reservationCancellations.creditResolution,
      meetsSevenDayRule: reservationCancellations.meetsSevenDayRule,
      sequenceId: reservationCancellations.sequenceId,
      sequencePosition: reservationCancellations.sequencePosition,
      isThirdCancellation: reservationCancellations.isThirdCancellation,
      canGenerateCreditCandidate: reservationCancellations.canGenerateCreditCandidate,
      nonEligibilityReason: reservationCancellations.nonEligibilityReason,
      isHabitualReservation: reservationCancellations.isHabitualReservation,
    })
    .from(reservationCancellations)
    .where(eq(reservationCancellations.studentProfileId, studentProfileId))
    .orderBy(reservationCancellations.cancelledAt);

  const attendance = await db
    .select({
      id: reservationAttendanceRecords.id,
      reservationId: reservationAttendanceRecords.reservationId,
      classSessionId: reservationAttendanceRecords.classSessionId,
      outcome: reservationAttendanceRecords.outcome,
      source: reservationAttendanceRecords.source,
      recordedAt: reservationAttendanceRecords.recordedAt,
      regulationVersionId: reservationAttendanceRecords.regulationVersionId,
      correctionReason: reservationAttendanceRecords.correctionReason,
      correctedFromRecordId: reservationAttendanceRecords.correctedFromRecordId,
      supersededAt: reservationAttendanceRecords.supersededAt,
    })
    .from(reservationAttendanceRecords)
    .where(eq(reservationAttendanceRecords.studentProfileId, studentProfileId))
    .orderBy(reservationAttendanceRecords.recordedAt);

  const regulation = await resolveCurrentAcademicRegulation(db);
  const maximum = regulation.maxEligibleConsecutiveCancellations;
  const streak = maximum === null
    ? evaluateCancellationTimeline(await collectHabitualSequenceEvents(db, studentProfileId))
    : await readCancellationStreak(db, studentProfileId, maximum);

  return {
    studentProfileId,
    currentConsecutiveCancellations: streak.currentIsProvisional ? null : streak.currentConsecutiveCancellations,
    cancellations,
    attendance,
  };
}

export async function getStudentCancellationStreak(actor: Actor, maximum: number) {
  const [profile] = await db.select({ id: studentProfiles.id }).from(studentProfiles)
    .where(reservationOwnerIsStudent(actor));
  if (!profile) throw new ApplicationError("Student profile not found.", "student_profile_not_found", 404, true);
  return readCancellationStreak(db, profile.id, maximum);
}

export async function generateClassSessions(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = generateSessionsSchema.parse(input);

  const now = nowCenterTime();
  const horizonEnd = now.plus({ months: payload.horizonMonths }).endOf("day");
  return materializeClassSessions({ now, horizonEnd });
}

export async function materializeDefaultClassSessionsWindow() {
  const now = nowCenterTime();
  return materializeClassSessions({ now, horizonEnd: now.plus({ months: SESSION_GENERATION_HORIZON_MONTHS }).endOf("day") });
}

async function materializeTemplateSessions(
  tx: TransactionClient,
  template: typeof classTemplates.$inferSelect,
  regulation: AcademicRegulation,
  input: { now: DateTime; horizonEnd: DateTime },
) {
  let inserted = 0;
  let skipped = 0;
  let habitualReservations = 0;
  const habitualCapacityConflicts: string[] = [];
  const referenceTime = input.now.toJSDate();

  for (const candidate of generateRecurringSessionCandidates(template, input)) {
    const classSessionId = randomUUID();
    const capacity = Math.min(candidate.maxCapacity, regulation.maxClassCapacity);
    const result = await tx.insert(classSessions).values({
      ...candidate,
      id: classSessionId,
      status: "SCHEDULED",
      maxCapacity: capacity,
      regulationVersionId: regulation.id,
      isManuallyEdited: false,
    }).onConflictDoNothing();
    if (!result.rowCount) {
      skipped += 1;
      const conflict = await findExistingHabitualCapacityConflict(tx, {
        templateId: template.id, localDate: candidate.localDate, now: referenceTime,
        maxClassCapacity: regulation.maxClassCapacity,
      });
      if (conflict) habitualCapacityConflicts.push(conflict);
      continue;
    }

    inserted += 1;
    if (candidate.startsAtUtc < referenceTime) continue;
    const seats = await reserveGeneratedSessionHabitualSeats(tx, {
      classSessionId, templateId: template.id, localDate: candidate.localDate,
      capacity, regulationVersionId: regulation.id,
    });
    habitualReservations += seats.reserved;
    if (seats.capacityConflict) habitualCapacityConflicts.push(classSessionId);
  }
  return { inserted, skipped, habitualReservations, habitualCapacityConflicts };
}

async function materializeClassSessions(input: { now: DateTime; horizonEnd: DateTime }) {
  const regulation = await resolveCurrentAcademicRegulation(db, input.now.toJSDate());
  const templates = await db.select({ id: classTemplates.id })
    .from(classTemplates).where(eq(classTemplates.status, "ACTIVE"));
  let inserted = 0;
  let skipped = 0;
  let habitualReservations = 0;
  const habitualCapacityConflicts: string[] = [];

  for (const { id } of templates) {
    const result = await db.transaction(async (tx) => {
      await lockTemplateAssignments(tx, id);
      const [template] = await tx.select().from(classTemplates)
        .where(and(eq(classTemplates.id, id), eq(classTemplates.status, "ACTIVE")));
      if (template) return materializeTemplateSessions(tx, template, regulation, input);
    });
    if (!result) continue;
    inserted += result.inserted;
    skipped += result.skipped;
    habitualReservations += result.habitualReservations;
    habitualCapacityConflicts.push(...result.habitualCapacityConflicts);
  }

  return {
    inserted,
    skipped,
    habitualReservations,
    habitualCapacityConflicts,
    horizonEnd: input.horizonEnd.toISO(),
  };
}

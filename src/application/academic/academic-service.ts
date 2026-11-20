import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import {
  assignStudentTemplateSchema,
  blockCapacitySchema,
  cancelClassSessionSchema,
  cancelReservationSchema,
  cancellationHistorySchema,
  correctAttendanceSchema,
  createClassTemplateSchema,
  createOneOffSessionSchema,
  createStudentProfileSchema,
  detectAbsencesSchema,
  endStudentTemplateAssignmentSchema,
  generateSessionsSchema,
  recordAttendanceSchema,
  reserveSeatSchema,
  setClassTemplateStatusSchema,
  updateClassSessionSchema,
} from "@/src/application/academic/schemas";
import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { lockStudentProfile, tryGenerateAutoCreditFromCancellation } from "@/src/application/credits/credit-service";
import { cancelRecoveriesForCancelledSession, cancelRecoveryReservation, reserveRecovery } from "@/src/application/recovery/recovery-service";
import { calculateAvailableSpots } from "@/src/domain/academic/availability";
import { classifyCancellationTiming, evaluateCancellationSequence, type HabitualSequenceEvent } from "@/src/domain/academic/cancellation-rules";
import { SESSION_GENERATION_HORIZON_MONTHS } from "@/src/domain/academic/constants";
import { generateRecurringSessionCandidates } from "@/src/domain/academic/recurrence";
import { resolveLocalDateTime, toUtcDate } from "@/src/domain/time/local-datetime";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { type UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
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

async function getStudentProfileForUserId(tx: TransactionClient, userId: string): Promise<string> {
  const [profile] = await tx
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    throw new ApplicationError("Student profile not found.", "student_profile_not_found", 404, true);
  }

  return profile.id;
}

async function isHabitualReservation(
  tx: TransactionClient,
  input: {
    studentProfileId: string;
    templateId: string | null;
    localDate: string;
  },
): Promise<boolean> {
  if (!input.templateId) {
    return false;
  }

  const result = await tx.execute(sql`
    select 1
    from student_template_assignments sta
    where sta.student_profile_id = ${input.studentProfileId}
      and sta.template_id = ${input.templateId}
      and sta.effective_from <= ${input.localDate}
      and (sta.effective_to is null or sta.effective_to >= ${input.localDate})
    limit 1
  `);

  return result.rows.length > 0;
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
    const [existingReservation] = await tx
      .select({ id: classReservations.id })
      .from(classReservations)
      .where(
        sql`${classReservations.classSessionId} = ${row.id}
          and ${classReservations.studentProfileId} = ${input.studentProfileId}
          and ${classReservations.status} = 'CONFIRMED'`,
      )
      .limit(1);

    if (existingReservation) {
      continue;
    }

    const usage = await readSessionUsage(tx, row.id);
    const availableSpots = calculateAvailableSpots({
      capacity: Math.min(row.max_capacity, regulation.maxClassCapacity),
      ...usage,
    });

    if (availableSpots <= 0) {
      continue;
    }

    await tx.insert(classReservations).values({
      id: randomUUID(),
      classSessionId: row.id,
      studentProfileId: input.studentProfileId,
      status: "CONFIRMED",
      origin: "ORDINARY",
      regulationVersionId: regulation.id,
    });

    createdReservations += 1;
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

  const templateId = randomUUID();
  const regulation = await resolveCurrentAcademicRegulation(db);
  await db.insert(classTemplates).values({
    id: templateId,
    name: payload.name,
    isoWeekday: payload.isoWeekday,
    startsAtLocalTime: payload.startsAtLocalTime,
    durationMinutes: payload.durationMinutes,
    effectiveFrom: payload.effectiveFrom,
    effectiveTo: payload.effectiveTo ?? null,
    category: payload.category,
    maxCapacity: resolveConfiguredCapacity(payload.maxCapacity, regulation.maxClassCapacity),
    regulationVersionId: regulation.id,
    status: "ACTIVE",
  });

  return { templateId };
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

    if (nextEndsAtUtc.getTime() <= nextStartsAtUtc.getTime()) {
      throw new ApplicationError("Class session end time must be after start time.", "invalid_session_time_range", 400, true);
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

    if (previousMonth !== nextMonth) {
      await tx.execute(sql`
        select p.id
        from student_profiles p
        where p.id in (
          select student_profile_id from class_reservations
          where class_session_id = ${payload.classSessionId} and origin = 'MAKEUP' and status = 'CONFIRMED'
        )
        order by p.id
        for update
      `);
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
  });
}

export async function cancelClassSession(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = cancelClassSessionSchema.parse(input);

  return db.transaction(async (tx) => {
    const now = new Date();
    const regulation = await resolveCurrentAcademicRegulation(tx, now);
    await tx.select({ id: classSessions.id }).from(classSessions)
      .where(eq(classSessions.id, payload.classSessionId)).for("update");
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

    return {
      classSessionId: payload.classSessionId,
      cancelledRecoveries: recoveryResult.cancelledRecoveries,
      refundedRecoveries: recoveryResult.refundsCreated,
    };
  });
}

export async function assignStudentToTemplate(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = assignStudentTemplateSchema.parse(input);

  if (payload.effectiveTo && payload.effectiveTo < payload.effectiveFrom) {
    throw new ApplicationError("effectiveTo must be greater than or equal to effectiveFrom.", "invalid_date_range", 400, true);
  }

  return db.transaction(async (tx) => {
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

export async function endStudentTemplateAssignment(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = endStudentTemplateAssignmentSchema.parse(input);

  await db
    .update(studentTemplateAssignments)
    .set({
      effectiveTo: payload.effectiveTo ?? nowCenterTime().toISODate(),
      status: "ENDED",
      updatedAt: new Date(),
    })
    .where(eq(studentTemplateAssignments.id, payload.assignmentId));
}

export async function addSessionCapacityBlock(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = blockCapacitySchema.parse(input);

  return db.transaction(async (tx) => {
    const [session] = await tx.select({ maxCapacity: classSessions.maxCapacity })
      .from(classSessions).where(eq(classSessions.id, payload.classSessionId)).for("update");
    if (!session) {
      throw new ApplicationError("Class session not found.", "session_not_found", 404, true);
    }
    const regulation = await resolveCurrentAcademicRegulation(tx);
    const capacity = Math.min(session.maxCapacity, regulation.maxClassCapacity);
    const usage = await readSessionUsage(tx, payload.classSessionId);
    if (payload.isActive && usage.confirmedReservations + usage.blockedSpots + payload.blockedSpots > capacity) {
      throw new ApplicationError("El bloqueo supera las plazas disponibles.", "capacity_conflict", 409, true);
    }

    const blockId = randomUUID();
    await tx.insert(sessionCapacityBlocks).values({
      id: blockId,
      classSessionId: payload.classSessionId,
      blockedSpots: payload.blockedSpots,
      reason: payload.reason,
      blockedByUserId: actor.userId,
      isActive: payload.isActive,
      regulationVersionId: regulation.id,
    });
    return { blockId };
  });
}

async function readSessionUsage(reader: QueryExecutor, classSessionId: string) {
  const result = await reader.execute(sql`
    select
      (select count(*)::int from class_reservations where class_session_id = ${classSessionId} and status = 'CONFIRMED') as "confirmedReservations",
      (select coalesce(sum(blocked_spots), 0)::int from session_capacity_blocks where class_session_id = ${classSessionId} and is_active) as "blockedSpots"
  `);
  return result.rows[0] as { confirmedReservations: number; blockedSpots: number };
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
  return createReservationTransaction(payload.classSessionId, payload.studentProfileId);
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

  return createReservationTransaction(classSessionId, profile.id);
}

async function createReservationTransaction(classSessionId: string, studentProfileId: string) {
  return db.transaction(async (tx) => {
    const lockedSessionRows = await tx.execute(sql`
      select id, max_capacity, status
      from class_sessions
      where id = ${classSessionId}
      for update
    `);
    const lockedSession = lockedSessionRows.rows[0] as
      | {
          id: string;
          max_capacity: number;
          status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
        }
      | undefined;

    if (!lockedSession) {
      throw new ApplicationError("Class session not found.", "session_not_found", 404, true);
    }

    if (lockedSession.status !== "SCHEDULED") {
      throw new ApplicationError("Class session is not open for reservation.", "session_not_reservable", 409, true);
    }

    const regulation = await resolveCurrentAcademicRegulation(tx);
    const { confirmedReservations, blockedSpots } = await readSessionUsage(tx, classSessionId);
    if (confirmedReservations + blockedSpots >= Math.min(lockedSession.max_capacity, regulation.maxClassCapacity)) {
      throw new ApplicationError("No spots available.", "no_spots_available", 409, true);
    }

    const reservationId = randomUUID();
    await tx.insert(classReservations).values({
      id: reservationId,
      classSessionId,
      studentProfileId,
      status: "CONFIRMED",
      origin: "ORDINARY",
      regulationVersionId: regulation.id,
    });

    return { reservationId };
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
  classLocalDate: string;
  templateId: string | null;
};

async function lockReservationForMutation(tx: TransactionClient, reservationId: string): Promise<LockedReservation> {
  const rows = await tx.execute(sql`
    select
      r.id as reservation_id,
      r.status as reservation_status,
      r.origin as reservation_origin,
      r.student_profile_id,
      r.class_session_id,
      s.status as class_status,
      s.starts_at_utc as class_starts_at_utc,
      s.local_date::text as class_local_date,
      s.template_id
    from class_reservations r
    inner join class_sessions s on s.id = r.class_session_id
    where r.id = ${reservationId}
    for update
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
    classLocalDate: row.class_local_date,
    templateId: row.template_id,
  };
}

export async function cancelReservation(actor: Actor, input: unknown) {
  const payload = cancelReservationSchema.parse(input);

  const reservation = await db.transaction((tx) => lockReservationForMutation(tx, payload.reservationId));
  if (reservation.reservationOrigin === "MAKEUP") {
    return cancelRecoveryReservation(actor, input);
  }

  return db.transaction(async (tx) => {
    const lockedReservation = await lockReservationForMutation(tx, payload.reservationId);

    if (actor.role === "STUDENT") {
      const profileId = await getStudentProfileForUserId(tx, actor.userId);
      if (profileId !== lockedReservation.studentProfileId) {
        throw new ApplicationError("Forbidden", "forbidden", 403, true);
      }
    } else {
      requireSuperAdmin(actor);
    }

    if (lockedReservation.reservationStatus !== "CONFIRMED") {
      throw new ApplicationError("Reservation already cancelled.", "reservation_not_confirmed", 409, true);
    }
    if (lockedReservation.classStatus !== "SCHEDULED") {
      throw new ApplicationError("Class session does not allow cancellation.", "session_not_cancellable", 409, true);
    }

    await lockStudentProfile(tx, lockedReservation.studentProfileId);
    const cancelledAt = new Date();
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

    const cancellationId = randomUUID();
    await tx.insert(reservationCancellations).values({
      id: cancellationId,
      reservationId: lockedReservation.reservationId,
      studentProfileId: lockedReservation.studentProfileId,
      classSessionId: lockedReservation.classSessionId,
      cancelledByUserId: actor.userId,
      cancelledAt,
      regulationVersionId: regulation.id,
      cancellationType: timing.type,
      hoursBeforeStart: timing.hoursBeforeStart,
      meetsSevenDayRule: timing.meetsSevenDayRule,
      isHabitualReservation: isHabitual,
      sequenceId: null,
      sequencePosition: null,
      isThirdCancellation: false,
      canGenerateCreditCandidate: false,
      nonEligibilityReason: null,
    });

    const alreadyCredited = await snapshotCancellationSequence(tx, lockedReservation.studentProfileId, cancellationId);
    const autoCredit = alreadyCredited
      ? { created: false, reason: "SEQUENCE_ALREADY_CREDITED" as const }
      : await tryGenerateAutoCreditFromCancellation(tx, cancellationId);

    return {
      cancellationId,
      cancellationType: timing.type,
      meetsSevenDayRule: timing.meetsSevenDayRule,
      autoCreditGenerated: autoCredit.created,
      autoCreditSkippedReason: autoCredit.reason ?? null,
      regulationVersionId: regulation.id,
    };
  });
}

export async function recordAttendance(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = recordAttendanceSchema.parse(input);

  return db.transaction(async (tx) => {
    const reservation = await lockReservationForMutation(tx, payload.reservationId);
    if (reservation.reservationStatus !== "CONFIRMED") {
      throw new ApplicationError("Cannot register attendance for cancelled reservation.", "reservation_not_confirmed", 409, true);
    }
    await lockStudentProfile(tx, reservation.studentProfileId);

    const [existingCancellation] = await tx
      .select({ id: reservationCancellations.id })
      .from(reservationCancellations)
      .where(eq(reservationCancellations.reservationId, reservation.reservationId))
      .limit(1);
    if (existingCancellation) {
      throw new ApplicationError("Cannot register attendance for cancelled reservation.", "reservation_cancelled", 409, true);
    }

    const [activeRecord] = await tx
      .select({
        id: reservationAttendanceRecords.id,
        outcome: reservationAttendanceRecords.outcome,
      })
      .from(reservationAttendanceRecords)
      .where(sql`${reservationAttendanceRecords.reservationId} = ${reservation.reservationId}
        and ${reservationAttendanceRecords.supersededAt} is null`)
      .limit(1);

    if (activeRecord && activeRecord.outcome === payload.outcome) {
      return { attendanceRecordId: activeRecord.id, updated: false };
    }

    if (activeRecord) {
      await tx
        .update(reservationAttendanceRecords)
        .set({
          supersededAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(reservationAttendanceRecords.id, activeRecord.id));
    }

    const recordedAt = new Date();
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
      correctedFromRecordId: activeRecord?.id ?? null,
      supersededAt: null,
    });

    return { attendanceRecordId, updated: true };
  });
}

export async function correctAttendance(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = correctAttendanceSchema.parse(input);

  return db.transaction(async (tx) => {
    const reservation = await lockReservationForMutation(tx, payload.reservationId);
    await lockStudentProfile(tx, reservation.studentProfileId);

    const [activeRecord] = await tx
      .select({
        id: reservationAttendanceRecords.id,
        outcome: reservationAttendanceRecords.outcome,
      })
      .from(reservationAttendanceRecords)
      .where(sql`${reservationAttendanceRecords.reservationId} = ${reservation.reservationId}
        and ${reservationAttendanceRecords.supersededAt} is null`)
      .limit(1);

    if (!activeRecord) {
      throw new ApplicationError("No attendance record to correct.", "attendance_not_found", 404, true);
    }
    if (activeRecord.outcome === payload.outcome) {
      throw new ApplicationError("Correction must change the outcome.", "attendance_same_outcome", 400, true);
    }

    await tx
      .update(reservationAttendanceRecords)
      .set({
        supersededAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reservationAttendanceRecords.id, activeRecord.id));

    const recordedAt = new Date();
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

    return { attendanceRecordId };
  });
}

export async function detectAbsences(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = detectAbsencesSchema.parse(input);
  const referenceTime = payload.referenceTimeUtc ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(903000042)`);

    const candidateRows = await tx.execute(sql`
      select
        r.id as reservation_id,
        r.student_profile_id,
        r.class_session_id
      from class_reservations r
      inner join class_sessions s on s.id = r.class_session_id
      left join reservation_cancellations rc on rc.reservation_id = r.id
      left join reservation_attendance_records ar on ar.reservation_id = r.id and ar.superseded_at is null
      where r.status = 'CONFIRMED'
        and s.status != 'CANCELLED'
        and s.ends_at_utc < ${referenceTime}
        and rc.id is null
        and ar.id is null
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

    return {
      createdAbsences: insertedRows.length,
      affectedProfiles: affectedProfiles.length,
    };
  });
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

  const events = await collectHabitualSequenceEvents(db, studentProfileId);

  let currentConsecutiveCancellations = 0;
  for (const event of events) {
    if (!event.isHabitualReservation) {
      continue;
    }
    if (event.eventType === "ATTENDANCE") {
      if (event.outcome === "ATTENDED") {
        currentConsecutiveCancellations = 0;
      }
      continue;
    }
    currentConsecutiveCancellations += 1;
  }

  return {
    studentProfileId,
    currentConsecutiveCancellations,
    cancellations,
    attendance,
  };
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

async function materializeClassSessions(input: { now: DateTime; horizonEnd: DateTime }) {
  const regulation = await resolveCurrentAcademicRegulation(db, input.now.toJSDate());
  const templates = await db
    .select({
      id: classTemplates.id,
      isoWeekday: classTemplates.isoWeekday,
      startsAtLocalTime: classTemplates.startsAtLocalTime,
      durationMinutes: classTemplates.durationMinutes,
      effectiveFrom: classTemplates.effectiveFrom,
      effectiveTo: classTemplates.effectiveTo,
      maxCapacity: classTemplates.maxCapacity,
    })
    .from(classTemplates)
    .where(eq(classTemplates.status, "ACTIVE"));

  let inserted = 0;
  let skipped = 0;

  for (const template of templates) {
    const candidates = generateRecurringSessionCandidates(template, {
      now: input.now,
      horizonEnd: input.horizonEnd,
    });

    for (const candidate of candidates) {
      const result = await db
        .insert(classSessions)
        .values({
          id: randomUUID(),
          templateId: candidate.templateId,
          localDate: candidate.localDate,
          startsAtUtc: candidate.startsAtUtc,
          endsAtUtc: candidate.endsAtUtc,
          status: "SCHEDULED",
          maxCapacity: Math.min(candidate.maxCapacity, regulation.maxClassCapacity),
          regulationVersionId: regulation.id,
          isManuallyEdited: false,
        })
        .onConflictDoNothing();

      if (result.rowCount && result.rowCount > 0) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return {
    inserted,
    skipped,
    horizonEnd: input.horizonEnd.toISO(),
  };
}

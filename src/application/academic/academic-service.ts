import "server-only";

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
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
  classSessions,
  classTemplates,
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
    inner join class_sessions cs on cs.id = ar.class_session_id
    where ar.student_profile_id = ${studentProfileId}
      and ar.superseded_at is null
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

async function recalculateStudentCancellationSequences(tx: TransactionClient, studentProfileId: string): Promise<void> {
  const events = await collectHabitualSequenceEvents(tx, studentProfileId);
  const evaluated = evaluateCancellationSequence(events);
  const byCancellationId = new Map(evaluated.map((item) => [item.id, item]));

  const existingRows = await tx
    .select({ id: reservationCancellations.id })
    .from(reservationCancellations)
    .where(eq(reservationCancellations.studentProfileId, studentProfileId));

  for (const row of existingRows) {
    const value = byCancellationId.get(row.id);
    await tx
      .update(reservationCancellations)
      .set({
        sequenceId: value?.sequenceId ?? null,
        sequencePosition: value?.sequencePosition ?? null,
        isThirdCancellation: value?.isThirdCancellation ?? false,
        canGenerateCreditCandidate: value?.canGenerateCreditCandidate ?? false,
        nonEligibilityReason: value?.nonEligibilityReason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(reservationCancellations.id, row.id));
  }
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
  await db.insert(classTemplates).values({
    id: templateId,
    name: payload.name,
    isoWeekday: payload.isoWeekday,
    startsAtLocalTime: payload.startsAtLocalTime,
    durationMinutes: payload.durationMinutes,
    effectiveFrom: payload.effectiveFrom,
    effectiveTo: payload.effectiveTo ?? null,
    category: payload.category,
    maxCapacity: payload.maxCapacity,
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
  await db.insert(classSessions).values({
    id: classSessionId,
    templateId: null,
    localDate: payload.localDate,
    startsAtUtc: toUtcDate(startLocalDateTime),
    endsAtUtc: toUtcDate(endLocalDateTime),
    status: "SCHEDULED",
    maxCapacity: payload.maxCapacity,
    isManuallyEdited: false,
  });

  return { classSessionId };
}

export async function updateClassSession(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = updateClassSessionSchema.parse(input);

  await db
    .update(classSessions)
    .set({
      startsAtUtc: payload.startsAtUtc,
      endsAtUtc: payload.endsAtUtc,
      maxCapacity: payload.maxCapacity,
      status: payload.status,
      isManuallyEdited: true,
      updatedAt: new Date(),
    })
    .where(eq(classSessions.id, payload.classSessionId));
}

export async function cancelClassSession(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = cancelClassSessionSchema.parse(input);

  await db
    .update(classSessions)
    .set({
      status: "CANCELLED",
      updatedAt: new Date(),
      isManuallyEdited: true,
    })
    .where(eq(classSessions.id, payload.classSessionId));
}

export async function assignStudentToTemplate(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = assignStudentTemplateSchema.parse(input);

  if (payload.effectiveTo && payload.effectiveTo < payload.effectiveFrom) {
    throw new ApplicationError("effectiveTo must be greater than or equal to effectiveFrom.", "invalid_date_range", 400, true);
  }

  const assignmentId = randomUUID();
  await db.insert(studentTemplateAssignments).values({
    id: assignmentId,
    studentProfileId: payload.studentProfileId,
    templateId: payload.templateId,
    effectiveFrom: payload.effectiveFrom,
    effectiveTo: payload.effectiveTo ?? null,
    status: payload.effectiveTo ? "ENDED" : "ACTIVE",
  });

  return { assignmentId };
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

  const blockId = randomUUID();
  await db.insert(sessionCapacityBlocks).values({
    id: blockId,
    classSessionId: payload.classSessionId,
    blockedSpots: payload.blockedSpots,
    reason: payload.reason,
    blockedByUserId: actor.userId,
    isActive: payload.isActive,
  });

  return { blockId };
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

  const [aggregate] = await db
    .select({
      confirmedReservations: sql<number>`
        (
          select count(*)::int
          from class_reservations cr
          where cr.class_session_id = ${classSessionId}
            and cr.status = 'CONFIRMED'
        )
      `,
      blockedSpots: sql<number>`
        (
          select coalesce(sum(scb.blocked_spots), 0)::int
          from session_capacity_blocks scb
          where scb.class_session_id = ${classSessionId}
            and scb.is_active = true
        )
      `,
    })
    .from(classSessions)
    .where(eq(classSessions.id, classSessionId))
    .limit(1);

  const confirmedReservations = Number(aggregate?.confirmedReservations ?? 0);
  const blockedSpots = Number(aggregate?.blockedSpots ?? 0);
  const availableSpots = calculateAvailableSpots({
    capacity: session.maxCapacity,
    confirmedReservations,
    blockedSpots,
  });

  return {
    capacity: session.maxCapacity,
    confirmedReservations,
    blockedSpots,
    availableSpots,
  };
}

export async function createReservation(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = reserveSeatSchema.parse(input);
  return createReservationTransaction(payload.classSessionId, payload.studentProfileId, payload.origin);
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

  return createReservationTransaction(classSessionId, profile.id, "ORDINARY");
}

async function createReservationTransaction(classSessionId: string, studentProfileId: string, origin: "ORDINARY" | "MAKEUP") {
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

    const countRows = await tx.execute(sql`
      select
        (select count(*)::int from class_reservations cr where cr.class_session_id = ${classSessionId} and cr.status = 'CONFIRMED') as confirmed_reservations,
        (select coalesce(sum(blocked_spots), 0)::int from session_capacity_blocks scb where scb.class_session_id = ${classSessionId} and scb.is_active = true) as blocked_spots
    `);
    const counts = countRows.rows[0] as { confirmed_reservations: number; blocked_spots: number };

    const usedSpots = counts.confirmed_reservations + counts.blocked_spots;
    if (usedSpots >= lockedSession.max_capacity) {
      throw new ApplicationError("No spots available.", "no_spots_available", 409, true);
    }

    const reservationId = randomUUID();
    await tx.insert(classReservations).values({
      id: reservationId,
      classSessionId,
      studentProfileId,
      status: "CONFIRMED",
      origin,
    });

    return { reservationId };
  });
}

type LockedReservation = {
  reservationId: string;
  reservationStatus: "CONFIRMED" | "CANCELLED";
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
      r.student_profile_id,
      r.class_session_id,
      s.status as class_status,
      s.starts_at_utc as class_starts_at_utc,
      s.local_date as class_local_date,
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

  return db.transaction(async (tx) => {
    const reservation = await lockReservationForMutation(tx, payload.reservationId);

    if (actor.role === "STUDENT") {
      const profileId = await getStudentProfileForUserId(tx, actor.userId);
      if (profileId !== reservation.studentProfileId) {
        throw new ApplicationError("Forbidden", "forbidden", 403, true);
      }
    } else {
      requireSuperAdmin(actor);
    }

    if (reservation.reservationStatus !== "CONFIRMED") {
      throw new ApplicationError("Reservation already cancelled.", "reservation_not_confirmed", 409, true);
    }
    if (reservation.classStatus !== "SCHEDULED") {
      throw new ApplicationError("Class session does not allow cancellation.", "session_not_cancellable", 409, true);
    }

    const cancelledAt = new Date();
    const timing = classifyCancellationTiming(cancelledAt, reservation.classStartsAtUtc);
    const isHabitual = await isHabitualReservation(tx, {
      studentProfileId: reservation.studentProfileId,
      templateId: reservation.templateId,
      localDate: reservation.classLocalDate,
    });

    await tx
      .update(classReservations)
      .set({
        status: "CANCELLED",
        updatedAt: cancelledAt,
      })
      .where(eq(classReservations.id, reservation.reservationId));

    const cancellationId = randomUUID();
    await tx.insert(reservationCancellations).values({
      id: cancellationId,
      reservationId: reservation.reservationId,
      studentProfileId: reservation.studentProfileId,
      classSessionId: reservation.classSessionId,
      cancelledByUserId: actor.userId,
      cancelledAt,
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

    await recalculateStudentCancellationSequences(tx, reservation.studentProfileId);

    return {
      cancellationId,
      cancellationType: timing.type,
      meetsSevenDayRule: timing.meetsSevenDayRule,
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
      .where(eq(reservationAttendanceRecords.reservationId, reservation.reservationId))
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

    const attendanceRecordId = randomUUID();
    await tx.insert(reservationAttendanceRecords).values({
      id: attendanceRecordId,
      reservationId: reservation.reservationId,
      studentProfileId: reservation.studentProfileId,
      classSessionId: reservation.classSessionId,
      outcome: payload.outcome,
      source: "MANUAL",
      recordedByUserId: actor.userId,
      recordedAt: new Date(),
      correctionReason: null,
      correctedFromRecordId: activeRecord?.id ?? null,
      supersededAt: null,
    });

    await recalculateStudentCancellationSequences(tx, reservation.studentProfileId);

    return { attendanceRecordId, updated: true };
  });
}

export async function correctAttendance(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = correctAttendanceSchema.parse(input);

  return db.transaction(async (tx) => {
    const reservation = await lockReservationForMutation(tx, payload.reservationId);

    const [activeRecord] = await tx
      .select({
        id: reservationAttendanceRecords.id,
        outcome: reservationAttendanceRecords.outcome,
      })
      .from(reservationAttendanceRecords)
      .where(eq(reservationAttendanceRecords.reservationId, reservation.reservationId))
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

    const attendanceRecordId = randomUUID();
    await tx.insert(reservationAttendanceRecords).values({
      id: attendanceRecordId,
      reservationId: reservation.reservationId,
      studentProfileId: reservation.studentProfileId,
      classSessionId: reservation.classSessionId,
      outcome: payload.outcome,
      source: "MANUAL",
      recordedByUserId: actor.userId,
      recordedAt: new Date(),
      correctionReason: payload.reason,
      correctedFromRecordId: activeRecord.id,
      supersededAt: null,
    });

    await recalculateStudentCancellationSequences(tx, reservation.studentProfileId);

    return { attendanceRecordId };
  });
}

export async function detectAbsences(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = detectAbsencesSchema.parse(input);
  const referenceTime = payload.referenceTimeUtc ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(903000042)`);

    const insertedRows = await tx.execute(sql`
      with candidates as (
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
      )
      insert into reservation_attendance_records (
        id,
        reservation_id,
        student_profile_id,
        class_session_id,
        outcome,
        source,
        recorded_by_user_id,
        recorded_at,
        correction_reason,
        corrected_from_record_id,
        superseded_at,
        created_at,
        updated_at
      )
      select
        gen_random_uuid()::text,
        c.reservation_id,
        c.student_profile_id,
        c.class_session_id,
        'ABSENT',
        'AUTO',
        null,
        ${referenceTime},
        null,
        null,
        null,
        now(),
        now()
      from candidates c
      on conflict do nothing
      returning student_profile_id
    `);

    const affectedProfiles = Array.from(
      new Set((insertedRows.rows as Array<{ student_profile_id: string }>).map((row) => row.student_profile_id)),
    );

    for (const profileId of affectedProfiles) {
      await recalculateStudentCancellationSequences(tx, profileId);
    }

    return {
      createdAbsences: insertedRows.rows.length,
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
      currentConsecutiveCancellations = 0;
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
          maxCapacity: candidate.maxCapacity,
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

import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { requireActiveStudentForBooking } from "@/src/application/auth/active-student";
import { createRecoveryConsumption, createRecoveryRefund, lockStudentProfile, materializeExpiredCredits, readCreditBalance } from "@/src/application/credits/credit-service";
import { cancelRecoverySchema, recoveryHistorySchema, recoveryOptionsCursorSchema, reserveRecoverySchema } from "@/src/application/recovery/schemas";
import { type UserRole } from "@/src/domain/auth/roles";
import { classifyCancellationTiming } from "@/src/domain/academic/cancellation-rules";
import { calculateAvailableSpots } from "@/src/domain/academic/availability";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { lockClassSessionForReservation } from "@/src/infrastructure/db/class-reservation-locks";
import { db } from "@/src/infrastructure/db/client";
import {
  classReservations,
  classSessions,
  creditLedgerMovements,
  studentProfiles,
} from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type Actor = {
  userId: string;
  role: UserRole;
};

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

const RECOVERY_OPTIONS_PAGE_SIZE = 100;

type LockedRecoveryReservation = {
  reservationId: string;
  reservationStatus: "CONFIRMED" | "CANCELLED";
  reservationOrigin: "ORDINARY" | "MAKEUP";
  studentProfileId: string;
  classSessionId: string;
  classStatus: "SCHEDULED" | "CANCELLED" | "COMPLETED";
  classStartsAtUtc: Date;
  classLocalDate: string;
};

function toMonthRange(localDate: string): { monthStartLocalDate: string; nextMonthStartLocalDate: string } {
  const local = DateTime.fromISO(localDate, { zone: CENTER_TIME_ZONE });
  if (!local.isValid) {
    throw new ApplicationError("Invalid session local date.", "invalid_local_date", 500, false);
  }
  return {
    monthStartLocalDate: local.startOf("month").toISODate() ?? localDate,
    nextMonthStartLocalDate: local.startOf("month").plus({ months: 1 }).toISODate() ?? localDate,
  };
}

async function getStudentProfileIdForActor(tx: TransactionClient, actor: Actor): Promise<string> {
  const [profile] = await tx
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, actor.userId))
    .limit(1);

  if (!profile) {
    throw new ApplicationError("Student profile not found.", "student_profile_not_found", 404, true);
  }

  return profile.id;
}

async function lockReservationForRecoveryCancellation(
  tx: TransactionClient,
  reservationId: string,
): Promise<LockedRecoveryReservation> {
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
      s.local_date::text as class_local_date
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
        class_local_date: string;
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
  };
}

async function countMonthlyRecoveries(tx: TransactionClient, studentProfileId: string, localDate: string): Promise<number> {
  const range = toMonthRange(localDate);

  const [result] = await tx
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(classReservations)
    .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .where(
      and(
        eq(classReservations.studentProfileId, studentProfileId),
        eq(classReservations.origin, "MAKEUP"),
        eq(classReservations.status, "CONFIRMED"),
        sql`${classSessions.localDate} >= ${range.monthStartLocalDate}`,
        sql`${classSessions.localDate} < ${range.nextMonthStartLocalDate}`,
      ),
    );

  return Number(result?.count ?? 0);
}

async function assertRecoveryConsumptionExists(tx: TransactionClient, reservationId: string): Promise<void> {
  const rows = await tx.execute(sql`
    select id
    from credit_ledger_movements
    where movement_type = 'RECOVERY_CONSUMPTION'
      and related_reservation_id = ${reservationId}
    for update
  `);

  if (rows.rows.length === 0) {
    throw new ApplicationError(
      "Recovery reservation has no associated consumption movement.",
      "recovery_consumption_missing",
      500,
      false,
    );
  }
}

export async function listFutureRecoveryOptions(actor: Actor, cursorInput?: unknown) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
  const cursor = recoveryOptionsCursorSchema.optional().parse(cursorInput);

  return db.transaction(async (tx) => {
    const studentProfileId = await getStudentProfileIdForActor(tx, actor);
    await lockStudentProfile(tx, studentProfileId);
    const now = new Date();
    const regulation = await resolveCurrentAcademicRegulation(tx, now);
    await materializeExpiredCredits(tx, studentProfileId, now);

    const { rows } = await tx.execute<{
      id: string;
      local_date: string;
      starts_at_utc: Date;
      cursor_starts_at_utc: string;
      ends_at_utc: Date;
      max_capacity: number;
      available_spots: number;
    }>(sql`
      with session_usage as (
        select
          s.id,
          s.local_date::text as local_date,
          s.starts_at_utc,
          s.ends_at_utc,
          least(s.max_capacity, ${regulation.maxClassCapacity}::int) as max_capacity,
          (
            select count(*)::int
            from class_reservations r
            where r.class_session_id = s.id and r.status = 'CONFIRMED'
          ) as confirmed_reservations,
          (
            select coalesce(sum(blocked_spots), 0)::int
            from session_capacity_blocks b
            where b.class_session_id = s.id and b.is_active = true
          ) as blocked_spots
        from class_sessions s
        where s.status = 'SCHEDULED'
          and s.starts_at_utc > ${now}
          ${cursor ? sql`and (s.starts_at_utc, s.id) > (${cursor.startsAtUtc}::timestamptz, ${cursor.sessionId})` : sql``}
          and not exists (
            select 1
            from class_reservations existing
            where existing.class_session_id = s.id
              and existing.student_profile_id = ${studentProfileId}
              and existing.status = 'CONFIRMED'
          )
      )
      select id, local_date, starts_at_utc, ends_at_utc, max_capacity,
        to_char(starts_at_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_starts_at_utc,
        max_capacity - confirmed_reservations - blocked_spots as available_spots
      from session_usage
      where confirmed_reservations + blocked_spots < max_capacity
      order by starts_at_utc asc, id asc
      limit ${RECOVERY_OPTIONS_PAGE_SIZE + 1}
    `);

    const sessions = rows.slice(0, RECOVERY_OPTIONS_PAGE_SIZE);
    const last = sessions.at(-1);
    const monthlyUsage = new Map<string, number>();
    for (const row of sessions) {
      const range = toMonthRange(row.local_date);
      if (!monthlyUsage.has(range.monthStartLocalDate)) {
        const used = await countMonthlyRecoveries(tx, studentProfileId, row.local_date);
        monthlyUsage.set(range.monthStartLocalDate, used);
      }
    }

    return {
      nextCursor: rows.length > RECOVERY_OPTIONS_PAGE_SIZE && last
        ? { startsAtUtc: last.cursor_starts_at_utc, sessionId: last.id }
        : null,
      sessions: sessions.map((row) => {
        const monthStart = toMonthRange(row.local_date).monthStartLocalDate;
        const used = monthlyUsage.get(monthStart) ?? 0;
        return {
          id: row.id,
          localDate: row.local_date,
          startsAtUtc: new Date(row.starts_at_utc),
          endsAtUtc: new Date(row.ends_at_utc),
          maxCapacity: row.max_capacity,
          availableSpots: row.available_spots,
          monthlyRecoveryUsed: used,
          monthlyRecoveryRemaining: Math.max(0, regulation.monthlyRecoveries - used),
        };
      }),
    };
  });
}

export async function reserveRecovery(actor: Actor, input: unknown, studentProfileIdForAdmin?: string) {
  if (studentProfileIdForAdmin ? actor.role !== "SUPER_ADMIN" : actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
  const payload = reserveRecoverySchema.parse(input);

  return db.transaction(async (tx) => {
    const studentProfileId = studentProfileIdForAdmin ?? await getStudentProfileIdForActor(tx, actor);
    await requireActiveStudentForBooking(tx, studentProfileId);
    const sessionRows = await tx.execute(sql`
      select id, status, starts_at_utc, local_date::text as local_date, max_capacity
      from class_sessions
      where id = ${payload.classSessionId}
      for update
    `);

    const session = sessionRows.rows[0] as
      | {
          id: string;
          status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
          starts_at_utc: Date;
          local_date: string;
          max_capacity: number;
        }
      | undefined;

    if (!session) {
      throw new ApplicationError("Class session not found.", "session_not_found", 404, true);
    }
    if (session.status !== "SCHEDULED") {
      throw new ApplicationError("Class session is not open for reservation.", "session_not_reservable", 409, true);
    }
    if (new Date(session.starts_at_utc).getTime() <= Date.now()) {
      throw new ApplicationError("Recovery class must be in the future.", "session_not_future", 409, true);
    }

    await lockStudentProfile(tx, studentProfileId);
    const consumedAt = new Date();
    await materializeExpiredCredits(tx, studentProfileId, consumedAt);

    const [existingReservation] = await tx
      .select({
        id: classReservations.id,
        origin: classReservations.origin,
      })
      .from(classReservations)
      .where(
        and(
          eq(classReservations.classSessionId, payload.classSessionId),
          eq(classReservations.studentProfileId, studentProfileId),
          eq(classReservations.status, "CONFIRMED"),
        ),
      )
      .limit(1);

    if (existingReservation) {
      if (existingReservation.origin !== "MAKEUP") {
        throw new ApplicationError("An ordinary reservation already exists for this session.", "ordinary_reservation_exists", 409, true);
      }
      const [existingConsumption] = await tx
        .select({
          id: creditLedgerMovements.id,
          sourceGrantMovementId: creditLedgerMovements.sourceGrantMovementId,
          expiresAt: creditLedgerMovements.expiresAt,
          idempotencyKey: creditLedgerMovements.idempotencyKey,
        })
        .from(creditLedgerMovements)
        .where(
          and(
            eq(creditLedgerMovements.movementType, "RECOVERY_CONSUMPTION"),
            eq(creditLedgerMovements.relatedReservationId, existingReservation.id),
            eq(creditLedgerMovements.studentProfileId, studentProfileId),
            eq(creditLedgerMovements.classSessionId, payload.classSessionId),
          ),
        )
        .limit(1);

      if (!existingConsumption) {
        throw new ApplicationError("Recovery reservation has no associated consumption movement.", "recovery_consumption_missing", 500);
      }
      if (payload.idempotencyKey && payload.idempotencyKey !== existingConsumption.idempotencyKey) {
        throw new ApplicationError("Recovery key does not match this operation.", "recovery_idempotency_conflict", 409, true);
      }

      return {
        reservationId: existingReservation.id,
        idempotent: true,
        consumedMovementId: existingConsumption.id,
        consumedFromGrantMovementId: existingConsumption.sourceGrantMovementId,
        consumedCreditExpiresAt: existingConsumption.expiresAt,
      };
    }

    const regulation = await resolveCurrentAcademicRegulation(tx, consumedAt);
    const monthlyRecoveries = await countMonthlyRecoveries(tx, studentProfileId, session.local_date);
    if (monthlyRecoveries >= regulation.monthlyRecoveries) {
      throw new ApplicationError("Monthly recovery limit reached.", "monthly_recovery_limit_reached", 409, true);
    }

    const counts = await tx.execute(sql`
      select
        (select count(*)::int from class_reservations r where r.class_session_id = ${payload.classSessionId} and r.status = 'CONFIRMED') as confirmed_reservations,
        (select coalesce(sum(blocked_spots), 0)::int from session_capacity_blocks b where b.class_session_id = ${payload.classSessionId} and b.is_active = true) as blocked_spots
    `);

    const usage = counts.rows[0] as { confirmed_reservations: number; blocked_spots: number };
    if (usage.confirmed_reservations + usage.blocked_spots >= Math.min(session.max_capacity, regulation.maxClassCapacity)) {
      throw new ApplicationError("No spots available.", "no_spots_available", 409, true);
    }

    const reservationId = randomUUID();
    await tx.insert(classReservations).values({
      id: reservationId,
      classSessionId: payload.classSessionId,
      studentProfileId,
      status: "CONFIRMED",
      origin: "MAKEUP",
      regulationVersionId: regulation.id,
      cancelledAt: null,
      cancelledByUserId: null,
    });

    const consumption = await createRecoveryConsumption(tx, {
      studentProfileId,
      reservationId,
      classSessionId: payload.classSessionId,
      idempotencyKey: payload.idempotencyKey ?? `recovery-consumption:${reservationId}`,
      consumedAt,
      regulationVersionId: regulation.id,
    });

    return {
      reservationId,
      idempotent: false,
      consumedMovementId: consumption.movementId,
      consumedFromGrantMovementId: consumption.sourceGrantMovementId,
      consumedCreditExpiresAt: consumption.expiresAt,
    };
  });
}

export async function cancelRecoveryReservation(actor: Actor, input: unknown) {
  const payload = cancelRecoverySchema.parse(input);

  return db.transaction(async (tx) => {
    const reservation = await lockReservationForRecoveryCancellation(tx, payload.reservationId);

    if (reservation.reservationOrigin !== "MAKEUP") {
      throw new ApplicationError("Reservation is not a recovery booking.", "reservation_not_recovery", 400, true);
    }

    if (actor.role === "STUDENT") {
      const studentProfileId = await getStudentProfileIdForActor(tx, actor);
      if (studentProfileId !== reservation.studentProfileId) {
        throw new ApplicationError("Forbidden", "forbidden", 403, true);
      }
    } else if (actor.role !== "SUPER_ADMIN") {
      throw new ApplicationError("Forbidden", "forbidden", 403, true);
    }

    if (reservation.reservationStatus !== "CONFIRMED") {
      return {
        reservationId: reservation.reservationId,
        cancelled: false,
        refunded: false,
        refundRestoredCredit: false,
      };
    }
    await lockStudentProfile(tx, reservation.studentProfileId);

    const cancelledAt = new Date();
    const regulation = await resolveCurrentAcademicRegulation(tx, cancelledAt);
    return {
      cancelled: true,
      ...await cancelLockedRecovery(tx, reservation, {
        cancelledAt, cancelledByUserId: actor.userId, regulation, refundReason: "Recovery cancelled on time",
      }),
    };
  });
}

type TimedRecoveryCancellation = {
  cancelledAt: Date;
  cancelledByUserId: string;
  regulation: { id: string; cancellationNoticeDays: number };
};

async function cancelLockedRecovery(
  tx: TransactionClient,
  { reservationId, classStartsAtUtc }: { reservationId: string; classStartsAtUtc: Date },
  { cancelledAt, cancelledByUserId, regulation, refundReason }: TimedRecoveryCancellation & { refundReason: string },
) {
  const timing = classifyCancellationTiming(cancelledAt, classStartsAtUtc, regulation.cancellationNoticeDays);
  await tx.update(classReservations).set({
    status: "CANCELLED",
    cancelledAt,
    cancelledByUserId,
    cancellationRegulationVersionId: regulation.id,
    updatedAt: cancelledAt,
  }).where(eq(classReservations.id, reservationId));

  if (!timing.meetsSevenDayRule) {
    return { reservationId, refunded: false, refundRestoredCredit: false };
  }

  await assertRecoveryConsumptionExists(tx, reservationId);
  const refund = await createRecoveryRefund(tx, {
    reservationId,
    refundedAt: cancelledAt,
    refundReason,
    regulationVersionId: regulation.id,
  });
  return { reservationId, refunded: refund.created, refundRestoredCredit: refund.restoredCredit };
}

export async function cancelFutureRecoveriesForWithdrawal(
  tx: TransactionClient,
  input: TimedRecoveryCancellation & { studentProfileId: string },
) {
  // The caller has locked the affected sessions and prevented new bookings for this student.
  const reservations = await tx.select({
    reservationId: classReservations.id,
    classStartsAtUtc: classSessions.startsAtUtc,
  }).from(classReservations).innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
    .where(and(
      eq(classReservations.studentProfileId, input.studentProfileId),
      eq(classReservations.origin, "MAKEUP"),
      eq(classReservations.status, "CONFIRMED"),
      gt(classSessions.startsAtUtc, input.cancelledAt),
    )).for("update", { of: classReservations });
  if (!reservations.length) return [];

  await lockStudentProfile(tx, input.studentProfileId);
  const cancelled = [];
  for (const reservation of reservations) {
    cancelled.push(await cancelLockedRecovery(tx, reservation, { ...input, refundReason: "Recovery cancelled on student withdrawal" }));
  }
  return cancelled;
}

export async function cancelRecoveriesForCancelledSession(
  tx: TransactionClient,
  input: {
    classSessionId: string;
    cancelledByUserId: string;
    reason: string;
    cancelledAt: Date;
    regulationVersionId: string;
  },
): Promise<{ cancelledRecoveries: number; refundsCreated: number }> {
  const rows = await tx.execute(sql`
    select
      r.id as reservation_id,
      r.student_profile_id,
      r.status as reservation_status
    from class_reservations r
    where r.class_session_id = ${input.classSessionId}
      and r.origin = 'MAKEUP'
    for update
  `);

  let cancelledRecoveries = 0;
  let refundsCreated = 0;
  for (const row of rows.rows as Array<{ reservation_id: string; student_profile_id: string; reservation_status: "CONFIRMED" | "CANCELLED" }>) {
    if (row.reservation_status !== "CONFIRMED") {
      continue;
    }
    await lockStudentProfile(tx, row.student_profile_id);
    await assertRecoveryConsumptionExists(tx, row.reservation_id);

    cancelledRecoveries += 1;
    await tx
      .update(classReservations)
      .set({
        status: "CANCELLED",
        cancelledAt: input.cancelledAt,
        cancelledByUserId: input.cancelledByUserId,
        cancellationRegulationVersionId: input.regulationVersionId,
        updatedAt: input.cancelledAt,
      })
      .where(eq(classReservations.id, row.reservation_id));

    const refund = await createRecoveryRefund(tx, {
      reservationId: row.reservation_id,
      refundedAt: input.cancelledAt,
      refundReason: input.reason,
      regulationVersionId: input.regulationVersionId,
    });
    if (refund.created) {
      refundsCreated += 1;
    }
  }

  return { cancelledRecoveries, refundsCreated };
}

export async function getRecoveryHistory(actor: Actor, input?: unknown) {
  const payload = recoveryHistorySchema.parse(input ?? {});

  return db.transaction(async (tx) => {
    let studentProfileId = payload.studentProfileId;
    if (actor.role === "STUDENT") {
      studentProfileId = await getStudentProfileIdForActor(tx, actor);
    } else if (actor.role !== "SUPER_ADMIN") {
      throw new ApplicationError("Forbidden", "forbidden", 403, true);
    }

    if (!studentProfileId) {
      throw new ApplicationError("studentProfileId is required for admin queries.", "student_profile_required", 400, true);
    }

    const reservations = await tx
      .select({
        reservationId: classReservations.id,
        status: classReservations.status,
        cancelledAt: classReservations.cancelledAt,
        regulationVersionId: classReservations.regulationVersionId,
        cancellationRegulationVersionId: classReservations.cancellationRegulationVersionId,
        classSessionId: classReservations.classSessionId,
        classStartsAtUtc: classSessions.startsAtUtc,
        classEndsAtUtc: classSessions.endsAtUtc,
        classLocalDate: classSessions.localDate,
      })
      .from(classReservations)
      .innerJoin(classSessions, eq(classSessions.id, classReservations.classSessionId))
      .where(
        and(
          eq(classReservations.studentProfileId, studentProfileId),
          eq(classReservations.origin, "MAKEUP"),
        ),
      )
      .orderBy(classSessions.startsAtUtc);

    const ledgerRows = await tx
      .select({
        id: creditLedgerMovements.id,
        movementType: creditLedgerMovements.movementType,
        relatedReservationId: creditLedgerMovements.relatedReservationId,
        amount: creditLedgerMovements.amount,
        createdAt: creditLedgerMovements.createdAt,
        expiresAt: creditLedgerMovements.expiresAt,
        refundRestoredCredit: creditLedgerMovements.refundRestoredCredit,
        regulationVersionId: creditLedgerMovements.regulationVersionId,
      })
      .from(creditLedgerMovements)
      .where(
        and(
          eq(creditLedgerMovements.studentProfileId, studentProfileId),
          inArray(creditLedgerMovements.movementType, ["RECOVERY_CONSUMPTION", "RECOVERY_REFUND"]),
        ),
      )
      .orderBy(creditLedgerMovements.createdAt);

    return {
      studentProfileId,
      reservations,
      ledgerRows,
    };
  });
}

export async function getRecoveryAvailabilityForSession(actor: Actor, classSessionId: string) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }

  return db.transaction(async (tx) => {
    const studentProfileId = await getStudentProfileIdForActor(tx, actor);
    await lockStudentProfile(tx, studentProfileId);
    const now = new Date();
    const regulation = await resolveCurrentAcademicRegulation(tx, now);
    await materializeExpiredCredits(tx, studentProfileId, now);

    const [session] = await tx
      .select({
        id: classSessions.id,
        localDate: classSessions.localDate,
        startsAtUtc: classSessions.startsAtUtc,
        status: classSessions.status,
        maxCapacity: classSessions.maxCapacity,
      })
      .from(classSessions)
      .where(eq(classSessions.id, classSessionId))
      .limit(1);

    if (!session) {
      throw new ApplicationError("Class session not found.", "session_not_found", 404, true);
    }

    const [aggregate] = await tx
      .select({
        confirmedReservations: sql<number>`
          (
            select count(*)::int
            from class_reservations r
            where r.class_session_id = ${classSessionId}
              and r.status = 'CONFIRMED'
          )
        `,
        blockedSpots: sql<number>`
          (
            select coalesce(sum(b.blocked_spots), 0)::int
            from session_capacity_blocks b
            where b.class_session_id = ${classSessionId}
              and b.is_active = true
          )
        `,
      })
      .from(classSessions)
      .where(eq(classSessions.id, classSessionId))
      .limit(1);

    const monthlyRecoveries = await countMonthlyRecoveries(tx, studentProfileId, session.localDate);
    const { availableCredits } = await readCreditBalance(tx, studentProfileId);

    return {
      classSessionId: session.id,
      localDate: session.localDate,
      startsAtUtc: session.startsAtUtc,
      status: session.status,
      availableSpots: calculateAvailableSpots({
        capacity: Math.min(session.maxCapacity, regulation.maxClassCapacity),
        confirmedReservations: Number(aggregate?.confirmedReservations ?? 0),
        blockedSpots: Number(aggregate?.blockedSpots ?? 0),
      }),
      availableCredits,
      monthlyRecoveryUsed: monthlyRecoveries,
      monthlyRecoveryRemaining: Math.max(0, regulation.monthlyRecoveries - monthlyRecoveries),
    };
  });
}


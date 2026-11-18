import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { createRecoveryConsumption, createRecoveryRefund, lockStudentProfile, materializeExpiredCredits } from "@/src/application/credits/credit-service";
import { cancelRecoverySchema, recoveryHistorySchema, reserveRecoverySchema } from "@/src/application/recovery/schemas";
import { type UserRole } from "@/src/domain/auth/roles";
import { classifyCancellationTiming } from "@/src/domain/academic/cancellation-rules";
import { calculateAvailableCredits } from "@/src/domain/credits/ledger";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
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

const MONTHLY_RECOVERY_LIMIT = 2;

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
  const rows = await tx.execute(sql`
    select
      r.id as reservation_id,
      r.status as reservation_status,
      r.origin as reservation_origin,
      r.student_profile_id,
      r.class_session_id,
      s.status as class_status,
      s.starts_at_utc as class_starts_at_utc,
      s.local_date as class_local_date
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

export async function listFutureRecoveryOptions(actor: Actor) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }

  return db.transaction(async (tx) => {
    const studentProfileId = await getStudentProfileIdForActor(tx, actor);
    await lockStudentProfile(tx, studentProfileId);
    await materializeExpiredCredits(tx, studentProfileId, new Date());

    const rows = await tx.execute(sql`
      select
        s.id,
        s.local_date,
        s.starts_at_utc,
        s.ends_at_utc,
        s.status,
        s.max_capacity,
        (
          select count(*)::int
          from class_reservations r
          where r.class_session_id = s.id and r.status = 'CONFIRMED'
        ) as confirmed_reservations,
        (
          select coalesce(sum(blocked_spots), 0)::int
          from session_capacity_blocks b
          where b.class_session_id = s.id and b.is_active = true
        ) as blocked_spots,
        exists(
          select 1
          from class_reservations existing
          where existing.class_session_id = s.id
            and existing.student_profile_id = ${studentProfileId}
            and existing.status = 'CONFIRMED'
        ) as already_reserved
      from class_sessions s
      where s.status = 'SCHEDULED'
        and s.starts_at_utc > now()
      order by s.starts_at_utc asc
      limit 100
    `);

    const sessions = (rows.rows as Array<{
      id: string;
      local_date: string;
      starts_at_utc: Date;
      ends_at_utc: Date;
      status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
      max_capacity: number;
      confirmed_reservations: number;
      blocked_spots: number;
      already_reserved: boolean;
    }>)
      .filter((row) => row.max_capacity - row.confirmed_reservations - row.blocked_spots > 0)
      .filter((row) => !row.already_reserved);

    const monthlyUsage = new Map<string, number>();
    for (const row of sessions) {
      const range = toMonthRange(row.local_date);
      if (!monthlyUsage.has(range.monthStartLocalDate)) {
        const used = await countMonthlyRecoveries(tx, studentProfileId, row.local_date);
        monthlyUsage.set(range.monthStartLocalDate, used);
      }
    }

    return {
      sessions: sessions.map((row) => {
        const monthStart = toMonthRange(row.local_date).monthStartLocalDate;
        const used = monthlyUsage.get(monthStart) ?? 0;
        return {
          id: row.id,
          localDate: row.local_date,
          startsAtUtc: new Date(row.starts_at_utc),
          endsAtUtc: new Date(row.ends_at_utc),
          maxCapacity: row.max_capacity,
          availableSpots: row.max_capacity - row.confirmed_reservations - row.blocked_spots,
          monthlyRecoveryUsed: used,
          monthlyRecoveryRemaining: Math.max(0, MONTHLY_RECOVERY_LIMIT - used),
        };
      }),
    };
  });
}

export async function reserveRecovery(actor: Actor, input: unknown) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
  const payload = reserveRecoverySchema.parse(input);

  return db.transaction(async (tx) => {
    const sessionRows = await tx.execute(sql`
      select id, status, starts_at_utc, local_date, max_capacity
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

    const studentProfileId = await getStudentProfileIdForActor(tx, actor);
    await lockStudentProfile(tx, studentProfileId);
    await materializeExpiredCredits(tx, studentProfileId, new Date());

    const [existingReservation] = await tx
      .select({
        id: classReservations.id,
        status: classReservations.status,
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
      const [existingConsumption] = await tx
        .select({
          id: creditLedgerMovements.id,
          sourceGrantMovementId: creditLedgerMovements.sourceGrantMovementId,
          expiresAt: creditLedgerMovements.expiresAt,
        })
        .from(creditLedgerMovements)
        .where(
          and(
            eq(creditLedgerMovements.movementType, "RECOVERY_CONSUMPTION"),
            eq(creditLedgerMovements.relatedReservationId, existingReservation.id),
          ),
        )
        .limit(1);

      return {
        reservationId: existingReservation.id,
        idempotent: true,
        consumedMovementId: existingConsumption?.id ?? null,
        consumedFromGrantMovementId: existingConsumption?.sourceGrantMovementId ?? null,
        consumedCreditExpiresAt: existingConsumption?.expiresAt ?? null,
      };
    }

    const monthlyRecoveries = await countMonthlyRecoveries(tx, studentProfileId, session.local_date);
    if (monthlyRecoveries >= MONTHLY_RECOVERY_LIMIT) {
      throw new ApplicationError("Monthly recovery limit reached.", "monthly_recovery_limit_reached", 409, true);
    }

    const counts = await tx.execute(sql`
      select
        (select count(*)::int from class_reservations r where r.class_session_id = ${payload.classSessionId} and r.status = 'CONFIRMED') as confirmed_reservations,
        (select coalesce(sum(blocked_spots), 0)::int from session_capacity_blocks b where b.class_session_id = ${payload.classSessionId} and b.is_active = true) as blocked_spots
    `);

    const usage = counts.rows[0] as { confirmed_reservations: number; blocked_spots: number };
    if (usage.confirmed_reservations + usage.blocked_spots >= session.max_capacity) {
      throw new ApplicationError("No spots available.", "no_spots_available", 409, true);
    }

    const reservationId = randomUUID();
    await tx.insert(classReservations).values({
      id: reservationId,
      classSessionId: payload.classSessionId,
      studentProfileId,
      status: "CONFIRMED",
      origin: "MAKEUP",
      cancelledAt: null,
      cancelledByUserId: null,
    });

    const consumedAt = new Date();
    const consumption = await createRecoveryConsumption(tx, {
      studentProfileId,
      reservationId,
      classSessionId: payload.classSessionId,
      idempotencyKey: payload.idempotencyKey ?? `recovery-consumption:${reservationId}`,
      consumedAt,
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
    const timing = classifyCancellationTiming(cancelledAt, reservation.classStartsAtUtc);

    await tx
      .update(classReservations)
      .set({
        status: "CANCELLED",
        cancelledAt,
        cancelledByUserId: actor.userId,
        updatedAt: cancelledAt,
      })
      .where(eq(classReservations.id, reservation.reservationId));

    if (!timing.meetsSevenDayRule) {
      return {
        reservationId: reservation.reservationId,
        cancelled: true,
        refunded: false,
        refundRestoredCredit: false,
      };
    }

    await assertRecoveryConsumptionExists(tx, reservation.reservationId);

    const refund = await createRecoveryRefund(tx, {
      reservationId: reservation.reservationId,
      refundedAt: cancelledAt,
      refundReason: "Recovery cancelled on time (>=7 days)",
    });

    return {
      reservationId: reservation.reservationId,
      cancelled: true,
      refunded: refund.created,
      refundRestoredCredit: refund.restoredCredit,
    };
  });
}

export async function cancelRecoveriesForCancelledSession(
  tx: TransactionClient,
  input: {
    classSessionId: string;
    cancelledByUserId: string;
    reason: string;
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
    const now = new Date();
    await tx
      .update(classReservations)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: input.cancelledByUserId,
        updatedAt: now,
      })
      .where(eq(classReservations.id, row.reservation_id));

    const refund = await createRecoveryRefund(tx, {
      reservationId: row.reservation_id,
      refundedAt: now,
      refundReason: input.reason,
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
    await materializeExpiredCredits(tx, studentProfileId, new Date());

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
    const rows = await readAvailableCreditsSnapshot(tx, studentProfileId);

    return {
      classSessionId: session.id,
      localDate: session.localDate,
      startsAtUtc: session.startsAtUtc,
      status: session.status,
      availableSpots: session.maxCapacity - Number(aggregate?.confirmedReservations ?? 0) - Number(aggregate?.blockedSpots ?? 0),
      availableCredits: calculateAvailableCredits(rows),
      monthlyRecoveryUsed: monthlyRecoveries,
      monthlyRecoveryRemaining: Math.max(0, MONTHLY_RECOVERY_LIMIT - monthlyRecoveries),
    };
  });
}

async function readAvailableCreditsSnapshot(tx: TransactionClient, studentProfileId: string) {
  return tx
    .select({
      movementType: creditLedgerMovements.movementType,
      amount: creditLedgerMovements.amount,
      refundRestoredCredit: creditLedgerMovements.refundRestoredCredit,
    })
    .from(creditLedgerMovements)
    .where(eq(creditLedgerMovements.studentProfileId, studentProfileId));
}


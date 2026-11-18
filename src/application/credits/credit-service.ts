import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";

import { creditStudentQuerySchema, manualCreditGrantSchema, manualCreditWithdrawSchema } from "@/src/application/credits/schemas";
import { type UserRole } from "@/src/domain/auth/roles";
import { pickNextFifoBucket, type FifoBucket } from "@/src/domain/credits/fifo";
import { calculateAutoCreditExpiration, calculateAvailableCredits, getCenterMonthUtcWindow } from "@/src/domain/credits/ledger";
import { db } from "@/src/infrastructure/db/client";
import { creditLedgerMovements, studentProfiles } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type Actor = {
  userId: string;
  role: UserRole;
};

export type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

const AUTO_MONTHLY_LIMIT = 2;

type LedgerRow = {
  id: string;
  movementType:
    | "AUTO_CANCELLATION_GRANT"
    | "MANUAL_GRANT"
    | "MANUAL_WITHDRAWAL"
    | "EXPIRATION"
    | "RECOVERY_CONSUMPTION"
    | "RECOVERY_REFUND";
  amount: number;
  createdAt: Date;
  expiresAt: Date | null;
  sourceGrantMovementId: string | null;
  sourceMovementId: string | null;
  refundRestoredCredit: boolean | null;
};

type CreditBucket = {
  grantMovementId: string;
  createdAt: Date;
  expiresAt: Date | null;
  availableUnits: number;
};

export type LedgerIntegrityReport = {
  studentProfileId: string | null;
  orphanRecoveryConsumptions: number;
  orphanRecoveryRefunds: number;
  duplicateRecoveryRefunds: number;
  manualMovementsMissingAudit: number;
};

function requireSuperAdmin(actor: Actor): void {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Forbidden", "forbidden", 403, true);
  }
}

async function resolveStudentProfileIdForActor(actor: Actor, requestedStudentProfileId?: string): Promise<string> {
  if (actor.role === "SUPER_ADMIN") {
    if (!requestedStudentProfileId) {
      throw new ApplicationError("studentProfileId is required for admin queries.", "student_profile_required", 400, true);
    }
    return requestedStudentProfileId;
  }

  const [profile] = await db
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(eq(studentProfiles.userId, actor.userId))
    .limit(1);

  if (!profile) {
    throw new ApplicationError("Student profile not found.", "student_profile_not_found", 404, true);
  }
  return profile.id;
}

export async function lockStudentProfile(tx: TransactionClient, studentProfileId: string): Promise<void> {
  const result = await tx.execute(sql`
    select id
    from student_profiles
    where id = ${studentProfileId}
    for update
  `);

  if (result.rows.length === 0) {
    throw new ApplicationError("Student profile not found.", "student_profile_not_found", 404, true);
  }
}

async function readLedgerRows(tx: TransactionClient, studentProfileId: string): Promise<LedgerRow[]> {
  return tx
    .select({
      id: creditLedgerMovements.id,
      movementType: creditLedgerMovements.movementType,
      amount: creditLedgerMovements.amount,
      createdAt: creditLedgerMovements.createdAt,
      expiresAt: creditLedgerMovements.expiresAt,
      sourceGrantMovementId: creditLedgerMovements.sourceGrantMovementId,
      sourceMovementId: creditLedgerMovements.sourceMovementId,
      refundRestoredCredit: creditLedgerMovements.refundRestoredCredit,
    })
    .from(creditLedgerMovements)
    .where(eq(creditLedgerMovements.studentProfileId, studentProfileId))
    .orderBy(creditLedgerMovements.createdAt, creditLedgerMovements.id);
}

function getOrCreateBucket(bucketByGrantId: Map<string, CreditBucket>, grantId: string, createdAt: Date, expiresAt: Date | null): CreditBucket {
  const current = bucketByGrantId.get(grantId);
  if (current) {
    return current;
  }
  const bucket: CreditBucket = {
    grantMovementId: grantId,
    createdAt,
    expiresAt,
    availableUnits: 0,
  };
  bucketByGrantId.set(grantId, bucket);
  return bucket;
}

function applyDebitFifo(bucketByGrantId: Map<string, CreditBucket>, amount: number): void {
  let remaining = amount;
  const orderedBuckets = [...bucketByGrantId.values()].sort((a, b) => {
    const aExpiry = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
    const bExpiry = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
    if (aExpiry !== bExpiry) {
      return aExpiry - bExpiry;
    }
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreated !== 0) {
      return byCreated;
    }
    return a.grantMovementId.localeCompare(b.grantMovementId);
  });

  for (const bucket of orderedBuckets) {
    if (remaining <= 0) {
      return;
    }
    const used = Math.min(bucket.availableUnits, remaining);
    bucket.availableUnits -= used;
    remaining -= used;
  }
}

function buildCreditBuckets(rows: LedgerRow[]): FifoBucket[] {
  const bucketByGrantId = new Map<string, CreditBucket>();

  for (const row of rows) {
    if (row.movementType === "AUTO_CANCELLATION_GRANT" || row.movementType === "MANUAL_GRANT") {
      const bucket = getOrCreateBucket(bucketByGrantId, row.id, row.createdAt, row.expiresAt);
      bucket.availableUnits += row.amount;
      continue;
    }

    if (row.movementType === "RECOVERY_REFUND" && row.refundRestoredCredit) {
      const grantId = row.sourceGrantMovementId;
      if (!grantId) {
        continue;
      }
      const bucket = getOrCreateBucket(bucketByGrantId, grantId, row.createdAt, row.expiresAt);
      if (!bucket.expiresAt && row.expiresAt) {
        bucket.expiresAt = row.expiresAt;
      }
      bucket.availableUnits += row.amount;
      continue;
    }

    if (row.movementType === "EXPIRATION") {
      const grantId = row.sourceGrantMovementId ?? row.sourceMovementId;
      if (!grantId) {
        applyDebitFifo(bucketByGrantId, row.amount);
        continue;
      }
      const bucket = getOrCreateBucket(bucketByGrantId, grantId, row.createdAt, null);
      bucket.availableUnits = Math.max(0, bucket.availableUnits - row.amount);
      continue;
    }

    if (row.movementType === "MANUAL_WITHDRAWAL" || row.movementType === "RECOVERY_CONSUMPTION") {
      if (!row.sourceGrantMovementId) {
        applyDebitFifo(bucketByGrantId, row.amount);
        continue;
      }
      const bucket = getOrCreateBucket(bucketByGrantId, row.sourceGrantMovementId, row.createdAt, null);
      bucket.availableUnits = Math.max(0, bucket.availableUnits - row.amount);
    }
  }

  return [...bucketByGrantId.values()].filter((bucket) => bucket.availableUnits > 0);
}

export async function materializeExpiredCredits(tx: TransactionClient, studentProfileId: string, referenceTime: Date): Promise<number> {
  const expiredGrants = await tx
    .select({
      id: creditLedgerMovements.id,
      amount: creditLedgerMovements.amount,
      expiresAt: creditLedgerMovements.expiresAt,
    })
    .from(creditLedgerMovements)
    .where(
      and(
        eq(creditLedgerMovements.studentProfileId, studentProfileId),
        inArray(creditLedgerMovements.movementType, ["AUTO_CANCELLATION_GRANT"]),
        isNotNull(creditLedgerMovements.expiresAt),
        lte(creditLedgerMovements.expiresAt, referenceTime),
      ),
    );

  let created = 0;

  for (const grant of expiredGrants) {
    const [existingExpiration] = await tx
      .select({ id: creditLedgerMovements.id })
      .from(creditLedgerMovements)
      .where(
        and(
          eq(creditLedgerMovements.movementType, "EXPIRATION"),
          eq(creditLedgerMovements.sourceMovementId, grant.id),
        ),
      )
      .limit(1);

    if (existingExpiration) {
      continue;
    }

    await tx.insert(creditLedgerMovements).values({
      id: randomUUID(),
      studentProfileId,
      movementType: "EXPIRATION",
      amount: grant.amount,
      createdAt: grant.expiresAt ?? referenceTime,
      expiresAt: null,
      reason: "Auto-expiration after 6 months",
      sourceGrantMovementId: grant.id,
      sourceMovementId: grant.id,
      idempotencyKey: `expiration:${grant.id}`,
    });
    created += 1;
  }

  return created;
}

export async function selectNextFifoCreditForConsumption(
  tx: TransactionClient,
  studentProfileId: string,
  referenceTime: Date,
): Promise<{ grantMovementId: string; expiresAt: Date | null } | null> {
  const rows = await readLedgerRows(tx, studentProfileId);
  const winner = pickNextFifoBucket(buildCreditBuckets(rows), referenceTime);
  if (!winner) {
    return null;
  }

  return { grantMovementId: winner.grantMovementId, expiresAt: winner.expiresAt };
}

async function readBalance(tx: TransactionClient, studentProfileId: string): Promise<{
  availableCredits: number;
  expiredCredits: number;
  totalCreditsGranted: number;
}> {
  const movements = await tx
    .select({
      movementType: creditLedgerMovements.movementType,
      amount: creditLedgerMovements.amount,
      refundRestoredCredit: creditLedgerMovements.refundRestoredCredit,
    })
    .from(creditLedgerMovements)
    .where(eq(creditLedgerMovements.studentProfileId, studentProfileId));

  const availableCredits = calculateAvailableCredits(movements);
  const expiredCredits = movements
    .filter((item) => item.movementType === "EXPIRATION")
    .reduce((acc, item) => acc + item.amount, 0);
  const totalCreditsGranted = movements
    .filter((item) => item.movementType === "AUTO_CANCELLATION_GRANT" || item.movementType === "MANUAL_GRANT")
    .reduce((acc, item) => acc + item.amount, 0);

  return {
    availableCredits,
    expiredCredits,
    totalCreditsGranted,
  };
}

export async function createRecoveryConsumption(
  tx: TransactionClient,
  input: {
    studentProfileId: string;
    reservationId: string;
    classSessionId: string;
    idempotencyKey: string;
    consumedAt: Date;
  },
): Promise<{ movementId: string; sourceGrantMovementId: string; expiresAt: Date | null }> {
  const fifo = await selectNextFifoCreditForConsumption(tx, input.studentProfileId, input.consumedAt);
  if (!fifo) {
    throw new ApplicationError("No available credits.", "no_available_credits", 409, true);
  }

  const existingForReservation = await tx
    .select({
      id: creditLedgerMovements.id,
      sourceGrantMovementId: creditLedgerMovements.sourceGrantMovementId,
      expiresAt: creditLedgerMovements.expiresAt,
    })
    .from(creditLedgerMovements)
    .where(
      and(
        eq(creditLedgerMovements.movementType, "RECOVERY_CONSUMPTION"),
        eq(creditLedgerMovements.relatedReservationId, input.reservationId),
      ),
    )
    .limit(1);

  if (existingForReservation[0]) {
    return {
      movementId: existingForReservation[0].id,
      sourceGrantMovementId: existingForReservation[0].sourceGrantMovementId ?? fifo.grantMovementId,
      expiresAt: existingForReservation[0].expiresAt,
    };
  }

  const movementId = randomUUID();
  const insertResult = await tx
    .insert(creditLedgerMovements)
    .values({
      id: movementId,
      studentProfileId: input.studentProfileId,
      movementType: "RECOVERY_CONSUMPTION",
      amount: 1,
      createdAt: input.consumedAt,
      expiresAt: fifo.expiresAt,
      reason: "Recovery reservation consumption",
      classSessionId: input.classSessionId,
      relatedReservationId: input.reservationId,
      sourceGrantMovementId: fifo.grantMovementId,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing();

  if (!insertResult.rowCount) {
    const [byIdempotencyKey] = await tx
      .select({
        id: creditLedgerMovements.id,
        sourceGrantMovementId: creditLedgerMovements.sourceGrantMovementId,
        expiresAt: creditLedgerMovements.expiresAt,
      })
      .from(creditLedgerMovements)
      .where(eq(creditLedgerMovements.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (byIdempotencyKey) {
      return {
        movementId: byIdempotencyKey.id,
        sourceGrantMovementId: byIdempotencyKey.sourceGrantMovementId ?? fifo.grantMovementId,
        expiresAt: byIdempotencyKey.expiresAt,
      };
    }
    throw new ApplicationError("Recovery credit consumption already exists.", "recovery_consumption_exists", 409, true);
  }

  return {
    movementId,
    sourceGrantMovementId: fifo.grantMovementId,
    expiresAt: fifo.expiresAt,
  };
}

export async function createRecoveryRefund(
  tx: TransactionClient,
  input: {
    reservationId: string;
    refundedAt: Date;
    refundReason: string;
  },
): Promise<{ created: boolean; restoredCredit: boolean }> {
  const rows = await tx.execute(sql`
    select
      m.id,
      m.student_profile_id,
      m.class_session_id,
      m.source_grant_movement_id,
      m.expires_at
    from credit_ledger_movements m
    where m.movement_type = 'RECOVERY_CONSUMPTION'
      and m.related_reservation_id = ${input.reservationId}
    for update
  `);

  const consumption = rows.rows[0] as
    | {
        id: string;
        student_profile_id: string;
        class_session_id: string | null;
        source_grant_movement_id: string | null;
        expires_at: Date | null;
      }
    | undefined;

  if (!consumption) {
    return { created: false, restoredCredit: false };
  }

  const [existingRefund] = await tx
    .select({ id: creditLedgerMovements.id, refundRestoredCredit: creditLedgerMovements.refundRestoredCredit })
    .from(creditLedgerMovements)
    .where(
      and(
        eq(creditLedgerMovements.movementType, "RECOVERY_REFUND"),
        eq(creditLedgerMovements.sourceMovementId, consumption.id),
      ),
    )
    .limit(1);

  if (existingRefund) {
    return { created: false, restoredCredit: Boolean(existingRefund.refundRestoredCredit) };
  }

  const restoredCredit = !consumption.expires_at || consumption.expires_at > input.refundedAt;

  await tx.insert(creditLedgerMovements).values({
    id: randomUUID(),
    studentProfileId: consumption.student_profile_id,
    movementType: "RECOVERY_REFUND",
    amount: 1,
    createdAt: input.refundedAt,
    expiresAt: consumption.expires_at,
    reason: input.refundReason,
    classSessionId: consumption.class_session_id,
    relatedReservationId: input.reservationId,
    sourceGrantMovementId: consumption.source_grant_movement_id,
    sourceMovementId: consumption.id,
    refundRestoredCredit: restoredCredit,
    idempotencyKey: `recovery-refund:${consumption.id}`,
  });

  return { created: true, restoredCredit };
}

export async function tryGenerateAutoCreditFromCancellation(
  tx: TransactionClient,
  cancellationId: string,
): Promise<{ created: boolean; reason?: "NOT_ELIGIBLE" | "MONTHLY_LIMIT" | "IDEMPOTENT_ALREADY_EXISTS" }> {
  const cancellationRows = await tx.execute(sql`
    select
      rc.id,
      rc.student_profile_id,
      rc.class_session_id,
      rc.cancelled_at,
      rc.can_generate_credit_candidate
    from reservation_cancellations rc
    where rc.id = ${cancellationId}
    for update
  `);

  const cancellation = cancellationRows.rows[0] as
    | {
        id: string;
        student_profile_id: string;
        class_session_id: string;
        cancelled_at: Date;
        can_generate_credit_candidate: boolean;
      }
    | undefined;

  if (!cancellation) {
    throw new ApplicationError("Cancellation not found.", "cancellation_not_found", 404, true);
  }

  if (!cancellation.can_generate_credit_candidate) {
    return { created: false, reason: "NOT_ELIGIBLE" };
  }

  await lockStudentProfile(tx, cancellation.student_profile_id);

  const { monthStartUtc, nextMonthStartUtc } = getCenterMonthUtcWindow(new Date(cancellation.cancelled_at));

  const [monthlyAutoCount] = await tx
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(creditLedgerMovements)
    .where(
      and(
        eq(creditLedgerMovements.studentProfileId, cancellation.student_profile_id),
        eq(creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
        gte(creditLedgerMovements.createdAt, monthStartUtc),
        lt(creditLedgerMovements.createdAt, nextMonthStartUtc),
      ),
    );

  if (Number(monthlyAutoCount?.count ?? 0) >= AUTO_MONTHLY_LIMIT) {
    return { created: false, reason: "MONTHLY_LIMIT" };
  }

  const movementId = randomUUID();
  const insertResult = await tx
    .insert(creditLedgerMovements)
    .values({
      id: movementId,
      studentProfileId: cancellation.student_profile_id,
      movementType: "AUTO_CANCELLATION_GRANT",
      amount: 1,
      createdAt: new Date(cancellation.cancelled_at),
      expiresAt: calculateAutoCreditExpiration(new Date(cancellation.cancelled_at)),
      reason: "Auto credit from third consecutive ON_TIME cancellation",
      classSessionId: cancellation.class_session_id,
      sourceCancellationId: cancellation.id,
      sourceGrantMovementId: movementId,
      idempotencyKey: `auto-cancellation:${cancellation.id}`,
    })
    .onConflictDoNothing();

  if (!insertResult.rowCount) {
    return { created: false, reason: "IDEMPOTENT_ALREADY_EXISTS" };
  }

  return { created: true };
}

export async function getCreditOverview(actor: Actor, input?: unknown) {
  const payload = creditStudentQuerySchema.parse(input ?? {});
  const studentProfileId = await resolveStudentProfileIdForActor(actor, payload.studentProfileId);

  return db.transaction(async (tx) => {
    await lockStudentProfile(tx, studentProfileId);
    await materializeExpiredCredits(tx, studentProfileId, new Date());
    const balance = await readBalance(tx, studentProfileId);

    const history = await tx
      .select({
        id: creditLedgerMovements.id,
        movementType: creditLedgerMovements.movementType,
        amount: creditLedgerMovements.amount,
        createdAt: creditLedgerMovements.createdAt,
        expiresAt: creditLedgerMovements.expiresAt,
        reason: creditLedgerMovements.reason,
        classSessionId: creditLedgerMovements.classSessionId,
        relatedReservationId: creditLedgerMovements.relatedReservationId,
        adminUserId: creditLedgerMovements.adminUserId,
        sourceCancellationId: creditLedgerMovements.sourceCancellationId,
        sourceGrantMovementId: creditLedgerMovements.sourceGrantMovementId,
        sourceMovementId: creditLedgerMovements.sourceMovementId,
        refundRestoredCredit: creditLedgerMovements.refundRestoredCredit,
      })
      .from(creditLedgerMovements)
      .where(eq(creditLedgerMovements.studentProfileId, studentProfileId))
      .orderBy(creditLedgerMovements.createdAt, creditLedgerMovements.id);

    return {
      studentProfileId,
      ...balance,
      history,
    };
  });
}

export async function getNextUsableCreditForActor(actor: Actor, input?: unknown) {
  const payload = creditStudentQuerySchema.parse(input ?? {});
  const studentProfileId = await resolveStudentProfileIdForActor(actor, payload.studentProfileId);

  return db.transaction(async (tx) => {
    await lockStudentProfile(tx, studentProfileId);
    await materializeExpiredCredits(tx, studentProfileId, new Date());
    const next = await selectNextFifoCreditForConsumption(tx, studentProfileId, new Date());
    return {
      studentProfileId,
      nextUsableGrantMovementId: next?.grantMovementId ?? null,
      nextUsableExpiresAt: next?.expiresAt ?? null,
    };
  });
}

export async function getLedgerIntegrityReport(actor: Actor, input?: unknown): Promise<LedgerIntegrityReport> {
  requireSuperAdmin(actor);
  const payload = creditStudentQuerySchema.parse(input ?? {});
  const studentProfileId = payload.studentProfileId ?? null;

  return db.transaction(async (tx) => {
    const consumptionIssues = await tx.execute(sql`
      select count(*)::int as count
      from credit_ledger_movements m
      left join class_reservations r on r.id = m.related_reservation_id
      where m.movement_type = 'RECOVERY_CONSUMPTION'
        and (
          m.related_reservation_id is null
          or r.id is null
          or r.origin <> 'MAKEUP'
        )
        and (${studentProfileId}::text is null or m.student_profile_id = ${studentProfileId})
    `);

    const refundIssues = await tx.execute(sql`
      select count(*)::int as count
      from credit_ledger_movements m
      left join credit_ledger_movements c
        on c.id = m.source_movement_id
       and c.movement_type = 'RECOVERY_CONSUMPTION'
      where m.movement_type = 'RECOVERY_REFUND'
        and (
          m.source_movement_id is null
          or c.id is null
        )
        and (${studentProfileId}::text is null or m.student_profile_id = ${studentProfileId})
    `);

    const duplicateRefundIssues = await tx.execute(sql`
      select count(*)::int as count
      from (
        select m.source_movement_id
        from credit_ledger_movements m
        where m.movement_type = 'RECOVERY_REFUND'
          and m.source_movement_id is not null
          and (${studentProfileId}::text is null or m.student_profile_id = ${studentProfileId})
        group by m.source_movement_id
        having count(*) > 1
      ) duplicates
    `);

    const manualAuditIssues = await tx.execute(sql`
      select count(*)::int as count
      from credit_ledger_movements m
      where m.movement_type in ('MANUAL_GRANT', 'MANUAL_WITHDRAWAL')
        and (
          m.admin_user_id is null
          or m.reason is null
          or btrim(m.reason) = ''
        )
        and (${studentProfileId}::text is null or m.student_profile_id = ${studentProfileId})
    `);

    return {
      studentProfileId,
      orphanRecoveryConsumptions: Number((consumptionIssues.rows[0] as { count: number } | undefined)?.count ?? 0),
      orphanRecoveryRefunds: Number((refundIssues.rows[0] as { count: number } | undefined)?.count ?? 0),
      duplicateRecoveryRefunds: Number((duplicateRefundIssues.rows[0] as { count: number } | undefined)?.count ?? 0),
      manualMovementsMissingAudit: Number((manualAuditIssues.rows[0] as { count: number } | undefined)?.count ?? 0),
    };
  });
}

export async function grantManualCredits(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = manualCreditGrantSchema.parse(input);

  return db.transaction(async (tx) => {
    await lockStudentProfile(tx, payload.studentProfileId);

    const movementId = randomUUID();
    await tx.insert(creditLedgerMovements).values({
      id: movementId,
      studentProfileId: payload.studentProfileId,
      movementType: "MANUAL_GRANT",
      amount: payload.amount,
      createdAt: new Date(),
      expiresAt: null,
      reason: payload.reason,
      classSessionId: payload.classSessionId ?? null,
      adminUserId: actor.userId,
      sourceGrantMovementId: movementId,
      idempotencyKey: `manual-grant:${movementId}`,
    });

    return { movementId };
  });
}

export async function withdrawManualCredits(actor: Actor, input: unknown) {
  requireSuperAdmin(actor);
  const payload = manualCreditWithdrawSchema.parse(input);

  return db.transaction(async (tx) => {
    await lockStudentProfile(tx, payload.studentProfileId);
    await materializeExpiredCredits(tx, payload.studentProfileId, new Date());

    const balance = await readBalance(tx, payload.studentProfileId);
    if (payload.amount > balance.availableCredits) {
      throw new ApplicationError("Cannot withdraw more credits than available.", "insufficient_credits", 409, true);
    }

    let remaining = payload.amount;
    const rows = await readLedgerRows(tx, payload.studentProfileId);
    const buckets = buildCreditBuckets(rows).sort((a, b) => {
      const aExpiry = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      const bExpiry = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
      if (aExpiry !== bExpiry) {
        return aExpiry - bExpiry;
      }
      const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
      if (byCreated !== 0) {
        return byCreated;
      }
      return a.grantMovementId.localeCompare(b.grantMovementId);
    });

    const movementIds: string[] = [];
    for (const bucket of buckets) {
      if (remaining <= 0) {
        break;
      }
      const toWithdraw = Math.min(bucket.availableUnits, remaining);
      if (toWithdraw <= 0) {
        continue;
      }
      const movementId = randomUUID();
      await tx.insert(creditLedgerMovements).values({
        id: movementId,
        studentProfileId: payload.studentProfileId,
        movementType: "MANUAL_WITHDRAWAL",
        amount: toWithdraw,
        createdAt: new Date(),
        expiresAt: bucket.expiresAt,
        reason: payload.reason,
        classSessionId: payload.classSessionId ?? null,
        adminUserId: actor.userId,
        sourceGrantMovementId: bucket.grantMovementId,
        idempotencyKey: `manual-withdraw:${movementId}`,
      });
      movementIds.push(movementId);
      remaining -= toWithdraw;
    }

    if (remaining > 0) {
      throw new ApplicationError("Cannot withdraw more credits than available.", "insufficient_credits", 409, true);
    }

    return { movementIds };
  });
}


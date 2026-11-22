import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { settlePendingCancellations } from "@/src/application/academic/cancellation-sequence-service";
import { creditStudentQuerySchema, manualCreditGrantSchema, manualCreditWithdrawSchema } from "@/src/application/credits/schemas";
import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { type UserRole } from "@/src/domain/auth/roles";
import { listAvailableFifoBuckets, pickNextFifoBucket, type FifoBucket } from "@/src/domain/credits/fifo";
import { calculateAutoCreditExpiration, getCenterMonthUtcWindow } from "@/src/domain/credits/ledger";
import { db } from "@/src/infrastructure/db/client";
import { academicRegulations, classReservations, classSessions, classTemplates, creditLedgerMovements, reservationCancellations, studentProfiles } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type Actor = {
  userId: string;
  role: UserRole;
};

export type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ledgerFields = {
  id: creditLedgerMovements.id,
  movementType: creditLedgerMovements.movementType,
  amount: creditLedgerMovements.amount,
  createdAt: creditLedgerMovements.createdAt,
  expiresAt: creditLedgerMovements.expiresAt,
  sourceGrantMovementId: creditLedgerMovements.sourceGrantMovementId,
  sourceMovementId: creditLedgerMovements.sourceMovementId,
  refundRestoredCredit: creditLedgerMovements.refundRestoredCredit,
};

type LedgerRow = Pick<typeof creditLedgerMovements.$inferSelect, keyof typeof ledgerFields>;

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
    .select(ledgerFields)
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
    const used = Math.min(Math.max(0, bucket.availableUnits), remaining);
    bucket.availableUnits -= used;
    remaining -= used;
  }
}

function buildCreditBuckets(rows: LedgerRow[]): FifoBucket[] {
  const bucketByGrantId = new Map<string, CreditBucket>();

  for (const row of rows) {
    if (row.movementType === "AUTO_CANCELLATION_GRANT" || row.movementType === "MANUAL_GRANT") {
      const bucket = getOrCreateBucket(bucketByGrantId, row.id, row.createdAt, row.expiresAt);
      bucket.createdAt = row.createdAt;
      bucket.expiresAt = row.expiresAt;
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
      // A linked debit can sort before its grant when both share a JavaScript millisecond.
      bucket.availableUnits -= row.amount;
    }
  }

  return [...bucketByGrantId.values()].filter((bucket) => bucket.availableUnits > 0);
}

function expiredUnitsAt(rows: LedgerRow[], grantId: string, expiresAt: Date) {
  return buildCreditBuckets(rows.filter((row) => row.createdAt <= expiresAt))
    .find((bucket) => bucket.grantMovementId === grantId)?.availableUnits ?? 0;
}

export async function materializeExpiredCredits(tx: TransactionClient, studentProfileId: string, referenceTime: Date): Promise<number> {
  const expiredGrants = await tx
    .select({
      id: creditLedgerMovements.id,
      expiresAt: creditLedgerMovements.expiresAt,
      regulationVersionId: creditLedgerMovements.regulationVersionId,
    })
    .from(creditLedgerMovements)
    .where(
      and(
        eq(creditLedgerMovements.studentProfileId, studentProfileId),
        inArray(creditLedgerMovements.movementType, ["AUTO_CANCELLATION_GRANT"]),
        isNotNull(creditLedgerMovements.expiresAt),
        lte(creditLedgerMovements.expiresAt, referenceTime),
      ),
    )
    .orderBy(creditLedgerMovements.expiresAt, creditLedgerMovements.id);

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

    if (existingExpiration || !grant.expiresAt) {
      continue;
    }

    const rows = await readLedgerRows(tx, studentProfileId);
    const expiresAt = grant.expiresAt;
    const amount = expiredUnitsAt(rows, grant.id, expiresAt);
    if (!amount) {
      continue;
    }

    await tx.insert(creditLedgerMovements).values({
      id: randomUUID(),
      studentProfileId,
      movementType: "EXPIRATION",
      amount,
      createdAt: expiresAt,
      expiresAt: null,
      reason: "Auto-expiration on the credit's original expiry date",
      regulationVersionId: grant.regulationVersionId,
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

function summarizeCreditBalance(movements: LedgerRow[], availableBuckets: FifoBucket[]) {
  const availableCredits = availableBuckets.reduce((sum, bucket) => sum + bucket.availableUnits, 0);
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

export async function readCreditBalance(tx: TransactionClient, studentProfileId: string, referenceTime = new Date()) {
  const movements = await readLedgerRows(tx, studentProfileId);
  const availableBuckets = listAvailableFifoBuckets(buildCreditBuckets(movements), referenceTime);
  return summarizeCreditBalance(movements, availableBuckets);
}

export async function createRecoveryConsumption(
  tx: TransactionClient,
  input: {
    studentProfileId: string;
    reservationId: string;
    classSessionId: string;
    idempotencyKey: string;
    consumedAt: Date;
    regulationVersionId: string;
  },
): Promise<{ movementId: string; sourceGrantMovementId: string; expiresAt: Date | null }> {
  const fifo = await selectNextFifoCreditForConsumption(tx, input.studentProfileId, input.consumedAt);
  if (!fifo) {
    throw new ApplicationError("No available credits.", "no_available_credits", 409, true);
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
      regulationVersionId: input.regulationVersionId,
      classSessionId: input.classSessionId,
      relatedReservationId: input.reservationId,
      sourceGrantMovementId: fifo.grantMovementId,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing();

  if (!insertResult.rowCount) {
    throw new ApplicationError("Recovery key belongs to a different operation.", "recovery_idempotency_conflict", 409, true);
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
    regulationVersionId: string;
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
        expires_at: string | Date | null;
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

  const expiresAt = consumption.expires_at ? new Date(consumption.expires_at) : null;
  const restoredCredit = !expiresAt || expiresAt > input.refundedAt;

  await tx.insert(creditLedgerMovements).values({
    id: randomUUID(),
    studentProfileId: consumption.student_profile_id,
    movementType: "RECOVERY_REFUND",
    amount: 1,
    createdAt: input.refundedAt,
    expiresAt,
    reason: input.refundReason,
    regulationVersionId: input.regulationVersionId,
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
  const [owner] = await tx.select({ id: reservationCancellations.studentProfileId }).from(reservationCancellations)
    .where(eq(reservationCancellations.id, cancellationId));
  if (!owner) throw new ApplicationError("Cancellation not found.", "cancellation_not_found", 404, true);
  await lockStudentProfile(tx, owner.id);
  const cancellationRows = await tx.execute(sql`
    select
      rc.id,
      rc.student_profile_id,
      rc.class_session_id,
      rc.cancelled_at,
      rc.can_generate_credit_candidate,
      rc.sequence_pending,
      rc.credit_resolution,
      rc.regulation_version_id,
      policy.max_eligible_consecutive_cancellations,
      policy.monthly_cancellation_credits,
      policy.credit_expiration_months
    from reservation_cancellations rc
    left join academic_regulations policy on policy.id = rc.regulation_version_id
    where rc.id = ${cancellationId}
    for update of rc
  `);

  const cancellation = cancellationRows.rows[0] as
    | {
        id: string;
        student_profile_id: string;
        class_session_id: string;
        cancelled_at: Date;
        can_generate_credit_candidate: boolean;
        sequence_pending: boolean;
        credit_resolution: "GRANTED" | "MONTHLY_LIMIT" | "NOT_ELIGIBLE" | null;
        max_eligible_consecutive_cancellations: number | null;
        regulation_version_id: string | null;
        monthly_cancellation_credits: number | null;
        credit_expiration_months: number | null;
      }
    | undefined;

  if (!cancellation) {
    throw new ApplicationError("Cancellation not found.", "cancellation_not_found", 404, true);
  }

  if (cancellation.sequence_pending || !cancellation.can_generate_credit_candidate) {
    return { created: false, reason: "NOT_ELIGIBLE" };
  }
  if (cancellation.credit_resolution === "MONTHLY_LIMIT") return { created: false, reason: "MONTHLY_LIMIT" };

  const [existing] = await tx.select({ id: creditLedgerMovements.id }).from(creditLedgerMovements)
    .where(and(eq(creditLedgerMovements.sourceCancellationId, cancellationId),
      eq(creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT")));
  if (existing) return { created: false, reason: "IDEMPOTENT_ALREADY_EXISTS" };

  const { monthStartUtc, nextMonthStartUtc } = getCenterMonthUtcWindow(new Date(cancellation.cancelled_at));
  const request = alias(reservationCancellations, "grant_request");
  const policy = alias(academicRegulations, "grant_policy");
  const countAt = sql`case when ${policy.maxEligibleConsecutiveCancellations} is not null
    then ${request.cancelledAt} else ${creditLedgerMovements.createdAt} end`;

  const [monthlyAutoCount] = await tx
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(creditLedgerMovements)
    .leftJoin(request, eq(request.id, creditLedgerMovements.sourceCancellationId))
    .leftJoin(policy, eq(policy.id, request.regulationVersionId))
    .where(
      and(
        eq(creditLedgerMovements.studentProfileId, cancellation.student_profile_id),
        eq(creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
        sql`${countAt} >= ${monthStartUtc.toISOString()}::timestamptz`,
        sql`${countAt} < ${nextMonthStartUtc.toISOString()}::timestamptz`,
      ),
    );

  const monthlyLimit = cancellation.monthly_cancellation_credits ?? INITIAL_REGULATION.monthlyCancellationCredits;
  if (Number(monthlyAutoCount?.count ?? 0) >= monthlyLimit) {
    return { created: false, reason: "MONTHLY_LIMIT" };
  }

  const movementId = randomUUID();
  const revisedPolicy = cancellation.max_eligible_consecutive_cancellations !== null;
  const generatedAt = revisedPolicy ? new Date() : new Date(cancellation.cancelled_at);
  const insertResult = await tx
    .insert(creditLedgerMovements)
    .values({
      id: movementId,
      studentProfileId: cancellation.student_profile_id,
      movementType: "AUTO_CANCELLATION_GRANT",
      amount: 1,
      createdAt: generatedAt,
      expiresAt: calculateAutoCreditExpiration(
        generatedAt,
        cancellation.credit_expiration_months ?? INITIAL_REGULATION.creditExpirationMonths,
      ),
      regulationVersionId: cancellation.regulation_version_id,
      reason: revisedPolicy
        ? "Crédito automático por cancelación habitual anticipada"
        : "Auto credit from third consecutive ON_TIME cancellation",
      // The source cancellation already links its session. Avoid taking a foreign-key lock
      // on another session while resolving deferred credits under the profile lock.
      classSessionId: revisedPolicy ? null : cancellation.class_session_id,
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

export function resolvePendingCancellationCredits(tx: TransactionClient, studentProfileId: string) {
  return settlePendingCancellations(tx, studentProfileId, tryGenerateAutoCreditFromCancellation);
}

function summarizeCreditOverview(history: LedgerRow[], now: Date) {
  const availableBuckets = listAvailableFifoBuckets(buildCreditBuckets(history), now);
  const byExpiration = new Map<number | null, { amount: number; expiresAt: Date | null }>();
  for (const { availableUnits, expiresAt } of availableBuckets) {
    const key = expiresAt?.getTime() ?? null;
    const existing = byExpiration.get(key);
    if (existing) existing.amount += availableUnits;
    else byExpiration.set(key, { amount: availableUnits, expiresAt });
  }
  const next = availableBuckets[0];
  return {
    ...summarizeCreditBalance(history, availableBuckets),
    availableExpirations: [...byExpiration.values()],
    nextUsableGrantMovementId: next?.grantMovementId ?? null,
    nextUsableExpiresAt: next?.expiresAt ?? null,
  };
}

export async function getCreditOverview(actor: Actor, input?: unknown) {
  const payload = creditStudentQuerySchema.parse(input ?? {});
  const studentProfileId = await resolveStudentProfileIdForActor(actor, payload.studentProfileId);

  return db.transaction(async (tx) => {
    await lockStudentProfile(tx, studentProfileId);
    if (actor.role === "STUDENT") await resolvePendingCancellationCredits(tx, studentProfileId);
    const now = new Date();
    await materializeExpiredCredits(tx, studentProfileId, now);

    const history = await tx
      .select({
        ...ledgerFields,
        reason: creditLedgerMovements.reason,
        regulationVersionId: creditLedgerMovements.regulationVersionId,
        classSessionId: sql<string | null>`coalesce(${creditLedgerMovements.classSessionId}, ${reservationCancellations.classSessionId})`,
        relatedReservationId: creditLedgerMovements.relatedReservationId,
        adminUserId: creditLedgerMovements.adminUserId,
        sourceCancellationId: creditLedgerMovements.sourceCancellationId,
      })
      .from(creditLedgerMovements)
      .leftJoin(reservationCancellations, eq(reservationCancellations.id, creditLedgerMovements.sourceCancellationId))
      .where(eq(creditLedgerMovements.studentProfileId, studentProfileId))
      .orderBy(creditLedgerMovements.createdAt, creditLedgerMovements.id);

    return { studentProfileId, ...summarizeCreditOverview(history, now), history };
  });
}

export async function readAdminCreditOverview(
  actor: Actor, tx: TransactionClient, studentProfileId: string, now: Date, limit: number, offset: number,
) {
  requireSuperAdmin(actor);
  const rows = await readLedgerRows(tx, studentProfileId);
  const expiredSources = new Set(rows.filter((row) => row.movementType === "EXPIRATION").map((row) => row.sourceMovementId));
  const dueGrants = rows.flatMap((row) => row.movementType === "AUTO_CANCELLATION_GRANT"
    && row.expiresAt && row.expiresAt <= now && !expiredSources.has(row.id)
    ? [{ ...row, expiresAt: row.expiresAt }] : []);
  dueGrants.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id));

  // Project due expirations through the same FIFO calculation without inserting ledger movements.
  const projected = [...rows];
  for (const grant of dueGrants) {
    const amount = expiredUnitsAt(projected, grant.id, grant.expiresAt);
    if (!amount) continue;
    projected.push({
      id: grant.id, movementType: "EXPIRATION", amount, createdAt: grant.expiresAt, expiresAt: null,
      sourceGrantMovementId: grant.id, sourceMovementId: grant.id, refundRestoredCredit: null,
    });
    projected.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  const { availableCredits, expiredCredits, availableExpirations } = summarizeCreditOverview(projected, now);
  const usedCredits = rows.reduce((sum, row) => sum + (row.movementType === "RECOVERY_CONSUMPTION" ? row.amount : 0), 0);
  const movements = await tx.select({
    id: creditLedgerMovements.id,
    movementType: creditLedgerMovements.movementType,
    amount: creditLedgerMovements.amount,
    createdAt: creditLedgerMovements.createdAt,
    reason: creditLedgerMovements.reason,
    refundRestoredCredit: creditLedgerMovements.refundRestoredCredit,
    classSessionId: classSessions.id,
    classStartsAt: classSessions.startsAtUtc,
    className: classTemplates.name,
  }).from(creditLedgerMovements)
    .leftJoin(classReservations, eq(classReservations.id, creditLedgerMovements.relatedReservationId))
    .leftJoin(reservationCancellations, eq(reservationCancellations.id, creditLedgerMovements.sourceCancellationId))
    .leftJoin(classSessions, eq(classSessions.id, sql`coalesce(${creditLedgerMovements.classSessionId},
      ${classReservations.classSessionId}, ${reservationCancellations.classSessionId})`))
    .leftJoin(classTemplates, eq(classTemplates.id, classSessions.templateId))
    .where(eq(creditLedgerMovements.studentProfileId, studentProfileId))
    .orderBy(desc(creditLedgerMovements.createdAt), desc(creditLedgerMovements.id))
    .limit(limit).offset(offset);

  return { availableCredits, expiredCredits, pendingExpirationUnits: expiredCredits - summarizeCreditBalance(rows, []).expiredCredits,
    availableExpirations, usedCredits, movements };
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
    const now = new Date();
    await materializeExpiredCredits(tx, payload.studentProfileId, now);

    const rows = await readLedgerRows(tx, payload.studentProfileId);
    const buckets = listAvailableFifoBuckets(buildCreditBuckets(rows), now);
    if (payload.amount > buckets.reduce((sum, bucket) => sum + bucket.availableUnits, 0)) {
      throw new ApplicationError("Cannot withdraw more credits than available.", "insufficient_credits", 409, true);
    }

    let remaining = payload.amount;
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


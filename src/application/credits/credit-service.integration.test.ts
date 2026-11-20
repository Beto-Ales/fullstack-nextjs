import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("credits integration (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let db: typeof import("@/src/infrastructure/db/client").db;
  let service: typeof import("@/src/application/credits/credit-service");
  let schema: typeof import("@/src/infrastructure/db/schema");
  let drizzle: typeof import("drizzle-orm");

  const adminActor = { userId: randomUUID(), role: "SUPER_ADMIN" as const };

  beforeAll(async () => {
    client = await createVerifiedTestClient();

    ({ db } = await import("@/src/infrastructure/db/client"));
    service = await import("@/src/application/credits/credit-service");
    schema = await import("@/src/infrastructure/db/schema");
    drizzle = await import("drizzle-orm");

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now())
       on conflict do nothing`,
      [adminActor.userId, `${adminActor.userId}@example.com`, `${adminActor.userId}@example.com`],
    );
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now())
       on conflict do nothing`,
      [adminActor.userId, `${adminActor.userId}@example.com`, `${adminActor.userId}@example.com`],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  async function seedCancellationCandidate(cancelledAtIso: string) {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();
    const templateId = randomUUID();
    const sessionId = randomUUID();
    const reservationId = randomUUID();
    const cancellationId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Credit', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );
    await client.query(
      `insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, status, effective_from, max_capacity, created_at, updated_at)
       values
        ($1, 'Template', 2, '18:00:00', 60, 'ACTIVE', '2026-01-01', 12, now(), now())`,
      [templateId],
    );
    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited, created_at, updated_at)
       values
        ($1, $2, '2026-02-04', '2026-02-04T17:00:00Z', '2026-02-04T18:00:00Z', 'SCHEDULED', 12, false, now(), now())`,
      [sessionId, templateId],
    );
    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CANCELLED', 'ORDINARY', now(), now())`,
      [reservationId, sessionId, studentProfileId],
    );
    await client.query(
      `insert into reservation_cancellations
        (id, reservation_id, student_profile_id, class_session_id, cancelled_by_user_id, cancelled_at, cancellation_type, hours_before_start,
         meets_seven_day_rule, is_habitual_reservation, sequence_id, sequence_position, is_third_cancellation, can_generate_credit_candidate,
         non_eligibility_reason, created_at, updated_at)
       values
        ($1, $2, $3, $4, $5, $6, 'ON_TIME', 200, true, true, 'seq-1', 3, true, true, null, now(), now())`,
      [cancellationId, reservationId, studentProfileId, sessionId, adminActor.userId, cancelledAtIso],
    );

    return { studentProfileId, cancellationId };
  }

  it("enforces idempotency for automatic generation", async () => {
    const seeded = await seedCancellationCandidate("2026-02-01T10:00:00.000Z");

    await db.transaction((tx) => service.tryGenerateAutoCreditFromCancellation(tx, seeded.cancellationId));
    await db.transaction((tx) => service.tryGenerateAutoCreditFromCancellation(tx, seeded.cancellationId));

    const [countResult] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(
        drizzle.and(
          drizzle.eq(schema.creditLedgerMovements.studentProfileId, seeded.studentProfileId),
          drizzle.eq(schema.creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
        ),
      );

    expect(Number(countResult?.count ?? 0)).toBe(1);
  });

  it("keeps monthly automatic generation capped at 2 under concurrency", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();
    const cancellationIds = [randomUUID(), randomUUID(), randomUUID()];

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Concurrent', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    for (const cancellationId of cancellationIds) {
      const templateId = randomUUID();
      const sessionId = randomUUID();
      const reservationId = randomUUID();
      await client.query(
        `insert into class_templates
          (id, name, iso_weekday, starts_at_local_time, duration_minutes, status, effective_from, max_capacity, created_at, updated_at)
         values
          ($1, 'Template', 2, '18:00:00', 60, 'ACTIVE', '2026-01-01', 12, now(), now())`,
        [templateId],
      );
      await client.query(
        `insert into class_sessions
          (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited, created_at, updated_at)
         values
          ($1, $2, '2026-02-04', '2026-02-04T17:00:00Z', '2026-02-04T18:00:00Z', 'SCHEDULED', 12, false, now(), now())`,
        [sessionId, templateId],
      );
      await client.query(
        `insert into class_reservations
          (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
         values
          ($1, $2, $3, 'CANCELLED', 'ORDINARY', now(), now())`,
        [reservationId, sessionId, studentProfileId],
      );
      await client.query(
        `insert into reservation_cancellations
          (id, reservation_id, student_profile_id, class_session_id, cancelled_by_user_id, cancelled_at, cancellation_type, hours_before_start,
           meets_seven_day_rule, is_habitual_reservation, sequence_id, sequence_position, is_third_cancellation, can_generate_credit_candidate,
           non_eligibility_reason, created_at, updated_at)
         values
          ($1, $2, $3, $4, $5, '2026-02-01T10:00:00.000Z', 'ON_TIME', 200, true, true, 'seq-1', 3, true, true, null, now(), now())`,
        [cancellationId, reservationId, studentProfileId, sessionId, adminActor.userId],
      );
    }

    await Promise.all(
      cancellationIds.map((id) => db.transaction((tx) => service.tryGenerateAutoCreditFromCancellation(tx, id))),
    );

    const [countResult] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(
        drizzle.and(
          drizzle.eq(schema.creditLedgerMovements.studentProfileId, studentProfileId),
          drizzle.eq(schema.creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
        ),
      );

    expect(Number(countResult?.count ?? 0)).toBe(2);
  });

  it("serializes concurrent withdrawals and blocks overdraft", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Withdraw', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await service.grantManualCredits(adminActor, {
      studentProfileId,
      amount: 4,
      reason: "Seed for withdrawal test",
    });

    const results = await Promise.allSettled([
      service.withdrawManualCredits(adminActor, {
        studentProfileId,
        amount: 3,
        reason: "Withdrawal A",
      }),
      service.withdrawManualCredits(adminActor, {
        studentProfileId,
        amount: 3,
        reason: "Withdrawal B",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it("rolls back failed withdrawals without partial movement writes", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Rollback', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await service.grantManualCredits(adminActor, {
      studentProfileId,
      amount: 1,
      reason: "Seed for rollback",
    });

    const [before] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.studentProfileId, studentProfileId));

    await expect(
      service.withdrawManualCredits(adminActor, {
        studentProfileId,
        amount: 2,
        reason: "Should fail",
      }),
    ).rejects.toBeDefined();

    const [after] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.studentProfileId, studentProfileId));

    expect(Number(after?.count ?? 0)).toBe(Number(before?.count ?? 0));
  });

  it("reports zero ledger integrity issues for valid manual movements", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Integrity', 'Valid', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await service.grantManualCredits(adminActor, {
      studentProfileId,
      amount: 2,
      reason: "Valid audit movement",
    });

    const report = await service.getLedgerIntegrityReport(adminActor, { studentProfileId });
    expect(report.orphanRecoveryConsumptions).toBe(0);
    expect(report.orphanRecoveryRefunds).toBe(0);
    expect(report.duplicateRecoveryRefunds).toBe(0);
    expect(report.manualMovementsMissingAudit).toBe(0);
  });

  it("detects malformed ledger movements with integrity report query", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Integrity', 'Broken', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, reason, idempotency_key)
       values
        ($1, $2, 'RECOVERY_CONSUMPTION', 1, now(), 'broken consumption', $3)`,
      [randomUUID(), studentProfileId, `broken-consumption:${randomUUID()}`],
    );
    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, reason, source_grant_movement_id, refund_restored_credit, idempotency_key)
       values
        ($1, $2, 'RECOVERY_REFUND', 1, now(), 'broken refund', null, false, $3)`,
      [randomUUID(), studentProfileId, `broken-refund:${randomUUID()}`],
    );
    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, idempotency_key)
       values
        ($1, $2, 'MANUAL_GRANT', 1, now(), $3)`,
      [randomUUID(), studentProfileId, `broken-manual:${randomUUID()}`],
    );

    const report = await service.getLedgerIntegrityReport(adminActor, { studentProfileId });
    expect(report.orphanRecoveryConsumptions).toBeGreaterThan(0);
    expect(report.orphanRecoveryRefunds).toBeGreaterThan(0);
    expect(report.manualMovementsMissingAudit).toBeGreaterThan(0);
  });
});


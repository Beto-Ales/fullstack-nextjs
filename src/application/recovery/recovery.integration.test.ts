import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("recovery integration (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;

  let recoveryService: typeof import("@/src/application/recovery/recovery-service");
  let academicService: typeof import("@/src/application/academic/academic-service");
  let schema: typeof import("@/src/infrastructure/db/schema");
  let db: typeof import("@/src/infrastructure/db/client").db;
  let drizzle: typeof import("drizzle-orm");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    recoveryService = await import("@/src/application/recovery/recovery-service");
    academicService = await import("@/src/application/academic/academic-service");
    schema = await import("@/src/infrastructure/db/schema");
    ({ db } = await import("@/src/infrastructure/db/client"));
    drizzle = await import("drizzle-orm");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  async function seedStudent() {
    const userId = randomUUID();
    const profileId = randomUUID();
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [userId, `${userId}@example.com`, `${userId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Recovery', 'Student', now(), now())`,
      [profileId, userId],
    );
    return { userId, profileId };
  }

  async function seedAdmin() {
    const userId = randomUUID();
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now())`,
      [userId, `${userId}@example.com`, `${userId}@example.com`],
    );
    return { userId };
  }

  async function seedSession(localDate: string, maxCapacity = 12) {
    const templateId = randomUUID();
    const sessionId = randomUUID();
    const startsAt = DateTime.fromISO(`${localDate}T18:00:00`, { zone: CENTER_TIME_ZONE });
    const endsAt = startsAt.plus({ minutes: 60 });

    await client.query(
      `insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, status, effective_from, max_capacity, created_at, updated_at)
       values
        ($1, 'Recovery template', 2, '18:00:00', 60, 'ACTIVE', '2026-01-01', 12, now(), now())`,
      [templateId],
    );

    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited, created_at, updated_at)
       values
        ($1, $2, $3, $4, $5, 'SCHEDULED', $6, false, now(), now())`,
      [sessionId, templateId, localDate, startsAt.toUTC().toISO(), endsAt.toUTC().toISO(), maxCapacity],
    );

    return { sessionId };
  }

  async function grantCredits(profileId: string, amount: number, expiresAt?: string | null) {
    const movementId = randomUUID();
    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, expires_at, reason, source_grant_movement_id, idempotency_key)
       values
        ($1, $2, 'MANUAL_GRANT', $3, now(), $4, 'seed credit', $1, $5)`,
      [movementId, profileId, amount, expiresAt ?? null, `seed-grant:${movementId}`],
    );
    return movementId;
  }

  async function seedRecoveryReservationWithConsumption(input: {
    studentProfileId: string;
    classSessionId: string;
    consumptionExpiresAt: Date | null;
    sourceGrantMovementId: string;
  }) {
    const reservationId = randomUUID();
    const consumptionId = randomUUID();

    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CONFIRMED', 'MAKEUP', now(), now())`,
      [reservationId, input.classSessionId, input.studentProfileId],
    );

    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, expires_at, reason, class_session_id, related_reservation_id, source_grant_movement_id, idempotency_key)
       values
        ($1, $2, 'RECOVERY_CONSUMPTION', 1, now(), $3, 'seed consumption', $4, $5, $6, $7)`,
      [
        consumptionId,
        input.studentProfileId,
        input.consumptionExpiresAt ? input.consumptionExpiresAt.toISOString() : null,
        input.classSessionId,
        reservationId,
        input.sourceGrantMovementId,
        `seed-consumption:${consumptionId}`,
      ],
    );

    return { reservationId, consumptionId };
  }

  async function readConsumptionCount(studentProfileId: string) {
    const [consumptionCount] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(
        drizzle.and(
          drizzle.eq(schema.creditLedgerMovements.studentProfileId, studentProfileId),
          drizzle.eq(schema.creditLedgerMovements.movementType, "RECOVERY_CONSUMPTION"),
        ),
      );
    return Number(consumptionCount?.count ?? 0);
  }

  async function blockAllCapacity(classSessionId: string, blockedSpots: number) {
    await client.query(
      `insert into session_capacity_blocks
        (id, class_session_id, blocked_spots, reason, blocked_by_user_id, is_active, created_at, updated_at)
       values
        ($1, $2, $3, 'test block', null, true, now(), now())`,
      [randomUUID(), classSessionId, blockedSpots],
    );
  }

  it("reserves recovery and consumes one credit atomically", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-01-10");
    await grantCredits(student.profileId, 1, "2027-03-10T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const reserved = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: randomUUID() });
    expect(reserved.idempotent).toBe(false);
    expect(await readConsumptionCount(student.profileId)).toBe(1);
  });

  it("is idempotent and does not double-consume for repeated reservation attempts", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-01-12");
    await grantCredits(student.profileId, 1, "2027-03-10T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const first = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: "reservation-1" });
    const second = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: "reservation-2" });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(first.reservationId).toBe(second.reservationId);
    expect(await readConsumptionCount(student.profileId)).toBe(1);
  });

  it("rolls back reservation if credit consumption cannot be created", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-01-15");
    const actor = { userId: student.userId, role: "STUDENT" as const };

    await expect(
      recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: randomUUID() }),
    ).rejects.toBeDefined();

    const [reservations] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.classReservations)
      .where(
        drizzle.and(
          drizzle.eq(schema.classReservations.classSessionId, session.sessionId),
          drizzle.eq(schema.classReservations.studentProfileId, student.profileId),
          drizzle.eq(schema.classReservations.status, "CONFIRMED"),
        ),
      );

    expect(Number(reservations?.count ?? 0)).toBe(0);
    expect(await readConsumptionCount(student.profileId)).toBe(0);
  });

  it("allows only one successful reservation for the last remaining spot under concurrency", async () => {
    const studentA = await seedStudent();
    const studentB = await seedStudent();
    const session = await seedSession("2027-02-24", 1);
    await grantCredits(studentA.profileId, 1, "2027-07-20T10:00:00.000Z");
    await grantCredits(studentB.profileId, 1, "2027-07-20T10:00:00.000Z");

    const [a, b] = await Promise.allSettled([
      recoveryService.reserveRecovery({ userId: studentA.userId, role: "STUDENT" }, { classSessionId: session.sessionId, idempotencyKey: randomUUID() }),
      recoveryService.reserveRecovery({ userId: studentB.userId, role: "STUDENT" }, { classSessionId: session.sessionId, idempotencyKey: randomUUID() }),
    ]);

    const successCount = [a, b].filter((result) => result.status === "fulfilled").length;
    const failCount = [a, b].filter((result) => result.status === "rejected").length;
    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
  });

  it("prevents overbooking when capacity is fully blocked by administration", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-03-11", 2);
    await grantCredits(student.profileId, 1, "2027-07-20T10:00:00.000Z");
    await blockAllCapacity(session.sessionId, 2);

    await expect(
      recoveryService.reserveRecovery({ userId: student.userId, role: "STUDENT" }, { classSessionId: session.sessionId, idempotencyKey: randomUUID() }),
    ).rejects.toBeDefined();
  });

  it("does not allow two concurrent consumptions of the same last available credit", async () => {
    const student = await seedStudent();
    const sessionA = await seedSession("2027-03-25");
    const sessionB = await seedSession("2027-03-27");
    await grantCredits(student.profileId, 1, "2027-07-20T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const [first, second] = await Promise.allSettled([
      recoveryService.reserveRecovery(actor, { classSessionId: sessionA.sessionId, idempotencyKey: randomUUID() }),
      recoveryService.reserveRecovery(actor, { classSessionId: sessionB.sessionId, idempotencyKey: randomUUID() }),
    ]);

    const successCount = [first, second].filter((result) => result.status === "fulfilled").length;
    const failCount = [first, second].filter((result) => result.status === "rejected").length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(1);
    expect(await readConsumptionCount(student.profileId)).toBe(1);
  });

  it("uses FIFO credit by nearest expiration date", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-01-18");
    const laterExpiringGrant = await grantCredits(student.profileId, 1, "2027-06-10T10:00:00.000Z");
    const soonerExpiringGrant = await grantCredits(student.profileId, 1, "2027-04-10T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const reservation = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: randomUUID() });

    expect(reservation.consumedFromGrantMovementId).toBe(soonerExpiringGrant);
    expect(reservation.consumedFromGrantMovementId).not.toBe(laterExpiringGrant);
  });

  it("does not consume credit when monthly limit is reached", async () => {
    const student = await seedStudent();
    const sessionA = await seedSession("2027-02-06");
    const sessionB = await seedSession("2027-02-13");
    const sessionC = await seedSession("2027-02-20");
    await grantCredits(student.profileId, 3, "2027-05-10T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    await recoveryService.reserveRecovery(actor, { classSessionId: sessionA.sessionId, idempotencyKey: randomUUID() });
    await recoveryService.reserveRecovery(actor, { classSessionId: sessionB.sessionId, idempotencyKey: randomUUID() });

    await expect(
      recoveryService.reserveRecovery(actor, { classSessionId: sessionC.sessionId, idempotencyKey: randomUUID() }),
    ).rejects.toBeDefined();
  });

  it("cancels with 7+ days and creates refund", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-03-20");
    await grantCredits(student.profileId, 1, "2027-07-20T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const reserved = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: randomUUID() });
    const cancelled = await recoveryService.cancelRecoveryReservation(actor, { reservationId: reserved.reservationId });

    expect(cancelled.refunded).toBe(true);

    const [refundCount] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(
        drizzle.and(
          drizzle.eq(schema.creditLedgerMovements.studentProfileId, student.profileId),
          drizzle.eq(schema.creditLedgerMovements.movementType, "RECOVERY_REFUND"),
        ),
      );

    expect(Number(refundCount?.count ?? 0)).toBe(1);
  });

  it("cancels with less than 7 days and does not refund", async () => {
    const student = await seedStudent();
    const localDate = DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 2 }).toISODate();
    const session = await seedSession(localDate ?? "2027-01-01");
    await grantCredits(student.profileId, 1, "2027-07-20T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const reserved = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: randomUUID() });
    const cancelled = await recoveryService.cancelRecoveryReservation(actor, { reservationId: reserved.reservationId });

    expect(cancelled.refunded).toBe(false);
  });

  it("registers refund but does not restore balance when credit already expired", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-05-20");
    const grantId = await grantCredits(student.profileId, 1, "2027-01-01T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const reserved = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: randomUUID() });
    await db
      .insert(schema.creditLedgerMovements)
      .values({
        id: randomUUID(),
        studentProfileId: student.profileId,
        movementType: "EXPIRATION",
        amount: 1,
        createdAt: new Date("2027-01-01T10:00:00.000Z"),
        sourceGrantMovementId: grantId,
        sourceMovementId: grantId,
        idempotencyKey: `seed-expire:${grantId}`,
      });

    const cancelled = await recoveryService.cancelRecoveryReservation(actor, { reservationId: reserved.reservationId });
    expect(cancelled.refunded).toBe(true);
    expect(cancelled.refundRestoredCredit).toBe(false);
  });

  it("is idempotent when cancelling the same recovery twice", async () => {
    const student = await seedStudent();
    const session = await seedSession("2027-06-20");
    await grantCredits(student.profileId, 1, "2027-10-20T10:00:00.000Z");

    const actor = { userId: student.userId, role: "STUDENT" as const };
    const reserved = await recoveryService.reserveRecovery(actor, { classSessionId: session.sessionId, idempotencyKey: randomUUID() });

    const firstCancellation = await recoveryService.cancelRecoveryReservation(actor, { reservationId: reserved.reservationId });
    const secondCancellation = await recoveryService.cancelRecoveryReservation(actor, { reservationId: reserved.reservationId });

    expect(firstCancellation.cancelled).toBe(true);
    expect(secondCancellation.cancelled).toBe(false);

    const [refundCount] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(
        drizzle.and(
          drizzle.eq(schema.creditLedgerMovements.studentProfileId, student.profileId),
          drizzle.eq(schema.creditLedgerMovements.movementType, "RECOVERY_REFUND"),
        ),
      );

    expect(Number(refundCount?.count ?? 0)).toBe(1);
  });

  it("handles administrative cancellation with multiple recoveries and preserves refund linkage semantics", async () => {
    const admin = await seedAdmin();
    const studentA = await seedStudent();
    const studentB = await seedStudent();
    const session = await seedSession("2027-09-18");

    const grantA = await grantCredits(studentA.profileId, 1, "2028-01-10T10:00:00.000Z");
    const grantB = await grantCredits(studentB.profileId, 1, "2026-01-10T10:00:00.000Z");

    const validConsumption = await seedRecoveryReservationWithConsumption({
      studentProfileId: studentA.profileId,
      classSessionId: session.sessionId,
      consumptionExpiresAt: new Date("2028-01-10T10:00:00.000Z"),
      sourceGrantMovementId: grantA,
    });

    const expiredConsumption = await seedRecoveryReservationWithConsumption({
      studentProfileId: studentB.profileId,
      classSessionId: session.sessionId,
      consumptionExpiresAt: new Date("2026-01-10T10:00:00.000Z"),
      sourceGrantMovementId: grantB,
    });

    const cancelled = await academicService.cancelClassSession(
      { userId: admin.userId, role: "SUPER_ADMIN" },
      { classSessionId: session.sessionId },
    );

    expect(cancelled.cancelledRecoveries).toBe(2);
    expect(cancelled.refundedRecoveries).toBe(2);

    const refunds = await db
      .select({
        sourceMovementId: schema.creditLedgerMovements.sourceMovementId,
        sourceGrantMovementId: schema.creditLedgerMovements.sourceGrantMovementId,
        refundRestoredCredit: schema.creditLedgerMovements.refundRestoredCredit,
      })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.movementType, "RECOVERY_REFUND"));

    expect(refunds).toHaveLength(2);

    const validRefund = refunds.find((item) => item.sourceMovementId === validConsumption.consumptionId);
    const expiredRefund = refunds.find((item) => item.sourceMovementId === expiredConsumption.consumptionId);

    expect(validRefund?.sourceGrantMovementId).toBe(grantA);
    expect(validRefund?.refundRestoredCredit).toBe(true);

    expect(expiredRefund?.sourceGrantMovementId).toBe(grantB);
    expect(expiredRefund?.refundRestoredCredit).toBe(false);
  });

  it("does not duplicate refunds when administrative cancellation is repeated", async () => {
    const admin = await seedAdmin();
    const student = await seedStudent();
    const session = await seedSession("2027-10-16");
    const grant = await grantCredits(student.profileId, 1, "2028-02-10T10:00:00.000Z");
    await seedRecoveryReservationWithConsumption({
      studentProfileId: student.profileId,
      classSessionId: session.sessionId,
      consumptionExpiresAt: new Date("2028-02-10T10:00:00.000Z"),
      sourceGrantMovementId: grant,
    });

    await academicService.cancelClassSession({ userId: admin.userId, role: "SUPER_ADMIN" }, { classSessionId: session.sessionId });
    await academicService.cancelClassSession({ userId: admin.userId, role: "SUPER_ADMIN" }, { classSessionId: session.sessionId });

    const [refundCount] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.movementType, "RECOVERY_REFUND"));

    expect(Number(refundCount?.count ?? 0)).toBe(1);
  });

  it("rolls back session cancellation atomically if a recovery lacks consumption", async () => {
    const admin = await seedAdmin();
    const student = await seedStudent();
    const session = await seedSession("2027-11-13");

    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CONFIRMED', 'MAKEUP', now(), now())`,
      [randomUUID(), session.sessionId, student.profileId],
    );

    await expect(
      academicService.cancelClassSession({ userId: admin.userId, role: "SUPER_ADMIN" }, { classSessionId: session.sessionId }),
    ).rejects.toMatchObject({ code: "recovery_consumption_missing" });

    const [sessionStatus] = await db
      .select({ status: schema.classSessions.status })
      .from(schema.classSessions)
      .where(drizzle.eq(schema.classSessions.id, session.sessionId))
      .limit(1);

    expect(sessionStatus?.status).toBe("SCHEDULED");
  });

  it("keeps consistent state when reservation and administrative cancellation race", async () => {
    const admin = await seedAdmin();
    const student = await seedStudent();
    const session = await seedSession("2027-12-11", 1);
    await grantCredits(student.profileId, 1, "2028-03-01T10:00:00.000Z");

    const [reserveResult, cancelResult] = await Promise.allSettled([
      recoveryService.reserveRecovery({ userId: student.userId, role: "STUDENT" }, { classSessionId: session.sessionId, idempotencyKey: randomUUID() }),
      academicService.cancelClassSession({ userId: admin.userId, role: "SUPER_ADMIN" }, { classSessionId: session.sessionId }),
    ]);

    expect([reserveResult.status, cancelResult.status]).toContain("fulfilled");

    const [consumptionCount] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.movementType, "RECOVERY_CONSUMPTION"));

    const [refundCount] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.movementType, "RECOVERY_REFUND"));

    expect(Number(refundCount?.count ?? 0)).toBeLessThanOrEqual(Number(consumptionCount?.count ?? 0));
  });
});


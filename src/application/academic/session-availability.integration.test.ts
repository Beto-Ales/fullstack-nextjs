import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe("session availability contract (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;

  let academic: typeof import("@/src/application/academic/academic-service");
  let recovery: typeof import("@/src/application/recovery/recovery-service");
  let credit: typeof import("@/src/application/credits/credit-service");
  let regulationService: typeof import("@/src/application/academic/regulation-service");

  // Wednesday 7 January 2031, 18:00 in Copenhagen (CET).
  const now = new Date("2031-01-07T17:00:00Z");
  const admin = { role: "SUPER_ADMIN", userId: randomUUID() } as const;

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("@/src/application/academic/academic-service");
    recovery = await import("@/src/application/recovery/recovery-service");
    credit = await import("@/src/application/credits/credit-service");
    regulationService = await import("@/src/application/academic/regulation-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    vi.setSystemTime(now);
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role)
       values ($1, 'admin@example.com', 'admin@example.com', 'hash', 'SUPER_ADMIN')`,
      [admin.userId],
    );
  });

  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await client?.end(); });

  async function seedStudent() {
    const userId = randomUUID();
    const profileId = randomUUID();
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE')`,
      [userId, `${userId}@example.com`, `${userId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name)
       values ($1, $2, 'Availability', 'Student')`,
      [profileId, userId],
    );
    return { userId, profileId, actor: { userId, role: "STUDENT" as const } };
  }

  async function seedSession(input: {
    localDate: string;
    startsAtUtc: string;
    endsAtUtc: string;
    maxCapacity: number;
  }) {
    const id = randomUUID();
    await client.query(
      `insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
       values ($1, $2, $3, $4, $5)`,
      [id, input.localDate, input.startsAtUtc, input.endsAtUtc, input.maxCapacity],
    );
    return id;
  }

  async function seedReservation(profileId: string, classSessionId: string, status = "CONFIRMED") {
    const id = randomUUID();
    await client.query(
      `insert into class_reservations (id, class_session_id, student_profile_id, status)
       values ($1, $2, $3, $4)`,
      [id, classSessionId, profileId, status],
    );
    return id;
  }

  async function seedBlock(classSessionId: string, blockedSpots: number, isActive = true) {
    await client.query(
      `insert into session_capacity_blocks (id, class_session_id, blocked_spots, is_active)
       values ($1, $2, $3, $4)`,
      [randomUUID(), classSessionId, blockedSpots, isActive],
    );
  }

  async function countRows(table: string) {
    const { rows } = await client.query<{ count: number }>(`select count(*)::int as count from ${table}`);
    return rows[0].count;
  }

  it("reports physical free spots and reservable spots separately across session states", async () => {
    const student = await seedStudent();
    const upcoming = await seedSession({
      localDate: "2031-01-08", startsAtUtc: "2031-01-08T17:00:00Z", endsAtUtc: "2031-01-08T18:00:00Z", maxCapacity: 4,
    });
    const inProgress = await seedSession({
      localDate: "2031-01-07", startsAtUtc: "2031-01-07T16:30:00Z", endsAtUtc: "2031-01-07T17:30:00Z", maxCapacity: 4,
    });
    const endedByTime = await seedSession({
      localDate: "2031-01-06", startsAtUtc: "2031-01-06T16:00:00Z", endsAtUtc: "2031-01-06T17:00:00Z", maxCapacity: 4,
    });
    const completedByState = await seedSession({
      localDate: "2031-01-09", startsAtUtc: "2031-01-09T17:00:00Z", endsAtUtc: "2031-01-09T18:00:00Z", maxCapacity: 4,
    });
    const cancelled = await seedSession({
      localDate: "2031-01-10", startsAtUtc: "2031-01-10T17:00:00Z", endsAtUtc: "2031-01-10T18:00:00Z", maxCapacity: 4,
    });
    for (const classSessionId of [upcoming, inProgress, endedByTime, completedByState]) {
      await seedReservation(student.profileId, classSessionId);
    }
    await client.query("update class_sessions set status = 'COMPLETED' where id = $1", [completedByState]);
    await seedBlock(cancelled, 1);
    await academic.cancelClassSession(admin, { classSessionId: cancelled });

    expect(await academic.getClassSessionAvailability(upcoming)).toEqual({
      classSessionId: upcoming,
      localDate: "2031-01-08",
      sessionStatus: "SCHEDULED",
      startsAtUtc: new Date("2031-01-08T17:00:00Z"),
      endsAtUtc: new Date("2031-01-08T18:00:00Z"),
      physicalCapacity: 4,
      capacity: 4,
      confirmedReservations: 1,
      blockedSpots: 0,
      physicallyFreeSpots: 3,
      reservableSpots: 3,
      bookingStatus: "UPCOMING",
    });
    expect(await academic.getClassSessionAvailability(inProgress)).toMatchObject({
      physicallyFreeSpots: 3, reservableSpots: 0, bookingStatus: "IN_PROGRESS", sessionStatus: "SCHEDULED",
    });
    expect(await academic.getClassSessionAvailability(endedByTime)).toMatchObject({
      physicallyFreeSpots: 3, reservableSpots: 0, bookingStatus: "COMPLETED", sessionStatus: "SCHEDULED",
    });
    expect(await academic.getClassSessionAvailability(completedByState)).toMatchObject({
      physicallyFreeSpots: 3, reservableSpots: 0, bookingStatus: "COMPLETED", sessionStatus: "COMPLETED",
    });
    expect(await academic.getClassSessionAvailability(cancelled)).toMatchObject({
      sessionStatus: "CANCELLED",
      confirmedReservations: 0,
      blockedSpots: 1,
      physicallyFreeSpots: 3,
      reservableSpots: 0,
      bookingStatus: "CANCELLED",
    });
  });

  it("counts only confirmed reservations and active blocks", async () => {
    const confirmed = await seedStudent();
    const cancelled = await seedStudent();
    const target = await seedSession({
      localDate: "2031-01-08", startsAtUtc: "2031-01-08T17:00:00Z", endsAtUtc: "2031-01-08T18:00:00Z", maxCapacity: 3,
    });
    await seedReservation(confirmed.profileId, target);
    await seedReservation(cancelled.profileId, target, "CANCELLED");
    await seedBlock(target, 1);
    await seedBlock(target, 1, false);

    expect(await academic.getClassSessionAvailability(target)).toMatchObject({
      physicalCapacity: 3,
      confirmedReservations: 1,
      blockedSpots: 1,
      physicallyFreeSpots: 1,
      reservableSpots: 1,
      bookingStatus: "UPCOMING",
    });
  });

  it("applies the current regulation cap to reservable spots without changing physical capacity", async () => {
    vi.setSystemTime(new Date("2031-01-05T10:00:00Z"));
    await regulationService.publishAcademicRegulation(admin, {
      ...INITIAL_REGULATION, effectiveFrom: "2031-01-06", maxClassCapacity: 2,
    });
    vi.setSystemTime(now);

    const student = await seedStudent();
    const companion = await seedStudent();
    const target = await seedSession({
      localDate: "2031-01-08", startsAtUtc: "2031-01-08T17:00:00Z", endsAtUtc: "2031-01-08T18:00:00Z", maxCapacity: 4,
    });
    await seedReservation(student.profileId, target);
    await seedReservation(companion.profileId, target);

    expect(await academic.getClassSessionAvailability(target)).toMatchObject({
      physicalCapacity: 4,
      capacity: 2,
      physicallyFreeSpots: 2,
      reservableSpots: 0,
      bookingStatus: "UPCOMING",
    });
    expect(await recovery.getRecoveryAvailabilityForSession(student.actor, target)).toMatchObject({
      physicalCapacity: 4,
      capacity: 2,
      physicallyFreeSpots: 2,
      reservableSpots: 0,
      bookingStatus: "UPCOMING",
    });
  });

  it("keeps the recovery availability consistent with its credit and monthly counters", async () => {
    const owner = await seedStudent();
    const observer = await seedStudent();
    const withoutCredits = await seedStudent();
    await credit.grantManualCredits(admin, {
      requestId: randomUUID(), studentProfileId: owner.profileId, amount: 2, reason: "Availability fixture",
    });
    const target = await seedSession({
      localDate: "2031-01-08", startsAtUtc: "2031-01-08T17:00:00Z", endsAtUtc: "2031-01-08T18:00:00Z", maxCapacity: 2,
    });
    await seedReservation(observer.profileId, target);

    const availability = await recovery.getRecoveryAvailabilityForSession(owner.actor, target);
    expect(availability).toMatchObject({
      classSessionId: target,
      localDate: "2031-01-08",
      status: "SCHEDULED",
      physicalCapacity: 2,
      capacity: 2,
      confirmedReservations: 1,
      blockedSpots: 0,
      physicallyFreeSpots: 1,
      reservableSpots: 1,
      bookingStatus: "UPCOMING",
      availableCredits: 2,
      monthlyRecoveryUsed: 0,
      monthlyRecoveryRemaining: 2,
    });
    expect(availability.startsAtUtc).toEqual(new Date("2031-01-08T17:00:00Z"));
    expect(availability.endsAtUtc).toEqual(new Date("2031-01-08T18:00:00Z"));

    await recovery.reserveRecovery(owner.actor, { classSessionId: target });

    expect(await recovery.getRecoveryAvailabilityForSession(owner.actor, target)).toMatchObject({
      physicallyFreeSpots: 0,
      reservableSpots: 0,
      availableCredits: 1,
      monthlyRecoveryUsed: 1,
      monthlyRecoveryRemaining: 1,
    });
    expect(await recovery.getRecoveryAvailabilityForSession(withoutCredits.actor, target)).toMatchObject({
      physicallyFreeSpots: 0,
      reservableSpots: 0,
      availableCredits: 0,
      monthlyRecoveryUsed: 0,
      monthlyRecoveryRemaining: 2,
    });
  });

  it("keeps closed sessions non bookable and the mutation remains the authority", async () => {
    const student = await seedStudent();
    await credit.grantManualCredits(admin, {
      requestId: randomUUID(), studentProfileId: student.profileId, amount: 3, reason: "Availability fixture",
    });
    const started = await seedSession({
      localDate: "2031-01-07", startsAtUtc: "2031-01-07T16:30:00Z", endsAtUtc: "2031-01-07T17:30:00Z", maxCapacity: 3,
    });
    const cancelled = await seedSession({
      localDate: "2031-01-09", startsAtUtc: "2031-01-09T17:00:00Z", endsAtUtc: "2031-01-09T18:00:00Z", maxCapacity: 3,
    });
    await academic.cancelClassSession(admin, { classSessionId: cancelled });
    const lastSeat = await seedSession({
      localDate: "2031-01-10", startsAtUtc: "2031-01-10T17:00:00Z", endsAtUtc: "2031-01-10T18:00:00Z", maxCapacity: 1,
    });
    const companion = await seedStudent();
    await seedReservation(companion.profileId, lastSeat);

    expect(await recovery.getRecoveryAvailabilityForSession(student.actor, started)).toMatchObject({
      physicallyFreeSpots: 3, reservableSpots: 0, bookingStatus: "IN_PROGRESS",
    });
    expect(await recovery.getRecoveryAvailabilityForSession(student.actor, cancelled)).toMatchObject({
      status: "CANCELLED", physicallyFreeSpots: 3, reservableSpots: 0, bookingStatus: "CANCELLED",
    });
    await expect(recovery.reserveRecovery(student.actor, { classSessionId: cancelled }))
      .rejects.toMatchObject({ code: "session_not_reservable" });

    expect(await recovery.getRecoveryAvailabilityForSession(student.actor, lastSeat)).toMatchObject({
      physicallyFreeSpots: 0, reservableSpots: 0, bookingStatus: "UPCOMING",
    });
    await expect(recovery.reserveRecovery(student.actor, { classSessionId: lastSeat }))
      .rejects.toMatchObject({ code: "no_spots_available" });
  });

  it("rejects an availability read that ignores a reservation made after the read", async () => {
    const student = await seedStudent();
    const filling = await seedStudent();
    await credit.grantManualCredits(admin, {
      requestId: randomUUID(), studentProfileId: student.profileId, amount: 1, reason: "Availability fixture",
    });
    const target = await seedSession({
      localDate: "2031-01-08", startsAtUtc: "2031-01-08T17:00:00Z", endsAtUtc: "2031-01-08T18:00:00Z", maxCapacity: 1,
    });
    expect(await recovery.getRecoveryAvailabilityForSession(student.actor, target))
      .toMatchObject({ physicallyFreeSpots: 1, reservableSpots: 1, bookingStatus: "UPCOMING" });

    await academic.createReservation(admin, { classSessionId: target, studentProfileId: filling.profileId });

    expect(await recovery.getRecoveryAvailabilityForSession(student.actor, target))
      .toMatchObject({ physicallyFreeSpots: 0, reservableSpots: 0 });
    await expect(recovery.reserveRecovery(student.actor, { classSessionId: target }))
      .rejects.toMatchObject({ code: "no_spots_available" });
  });

  it("reads availability without writing reservations, blocks, sessions or credits", async () => {
    const student = await seedStudent();
    await credit.grantManualCredits(admin, {
      requestId: randomUUID(), studentProfileId: student.profileId, amount: 1, reason: "Availability fixture",
    });
    const target = await seedSession({
      localDate: "2031-01-08", startsAtUtc: "2031-01-08T17:00:00Z", endsAtUtc: "2031-01-08T18:00:00Z", maxCapacity: 2,
    });
    const tables = ["class_reservations", "session_capacity_blocks", "class_sessions", "credit_ledger_movements"];
    const before = await Promise.all(tables.map(countRows));

    await academic.getClassSessionAvailability(target);
    await recovery.getRecoveryAvailabilityForSession(student.actor, target);

    expect(await Promise.all(tables.map(countRows))).toEqual(before);
  });

  it("limits the recovery read to students and reports unknown sessions", async () => {
    const student = await seedStudent();
    const target = await seedSession({
      localDate: "2031-01-08", startsAtUtc: "2031-01-08T17:00:00Z", endsAtUtc: "2031-01-08T18:00:00Z", maxCapacity: 2,
    });
    await expect(recovery.getRecoveryAvailabilityForSession(admin, target))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(recovery.getRecoveryAvailabilityForSession(student.actor, randomUUID()))
      .rejects.toMatchObject({ code: "session_not_found" });
    await expect(academic.getClassSessionAvailability(randomUUID()))
      .rejects.toMatchObject({ code: "session_not_found" });
  });
});

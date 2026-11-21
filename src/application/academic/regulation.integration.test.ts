import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("academic regulation (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let regulationService: typeof import("@/src/application/academic/regulation-service");
  let academicService: typeof import("@/src/application/academic/academic-service");
  let creditService: typeof import("@/src/application/credits/credit-service");
  let recoveryService: typeof import("@/src/application/recovery/recovery-service");
  let db: typeof import("@/src/infrastructure/db/client").db;
  let admin: { userId: string; role: "SUPER_ADMIN" };
  let student: { userId: string; role: "STUDENT" };
  let profileId: string;

  const nextRules = {
    effectiveFrom: "2030-04-02",
    cancellationNoticeDays: 10,
    monthlyCancellationCredits: 1,
    monthlyRecoveries: 1,
    creditExpirationMonths: 3,
    maxClassCapacity: 2,
  };

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    regulationService = await import("@/src/application/academic/regulation-service");
    academicService = await import("@/src/application/academic/academic-service");
    creditService = await import("@/src/application/credits/credit-service");
    recoveryService = await import("@/src/application/recovery/recovery-service");
    ({ db } = await import("@/src/infrastructure/db/client"));
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    vi.setSystemTime(new Date("2030-04-01T10:00:00Z"));
    admin = { userId: randomUUID(), role: "SUPER_ADMIN" };
    student = { userId: randomUUID(), role: "STUDENT" };
    profileId = randomUUID();
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role)
       values ($1, 'admin@example.com', 'admin@example.com', 'hash', 'SUPER_ADMIN'),
              ($2, 'student@example.com', 'student@example.com', 'hash', 'STUDENT')`,
      [admin.userId, student.userId],
    );
    await client.query(
      "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Test', 'Student')",
      [profileId, student.userId],
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function createSession(localDate: string) {
    const result = await academicService.createOneOffClassSession(admin, {
      localDate, startsAtLocalTime: "18:00", durationMinutes: 60,
    });
    return result.classSessionId;
  }

  async function createHabitualTemplate() {
    const { templateId } = await academicService.createClassTemplate(admin, {
      name: "Habitual", isoWeekday: 2, startsAtLocalTime: "18:00", durationMinutes: 60, effectiveFrom: "2030-03-01",
    });
    await academicService.assignStudentToTemplate(admin, { templateId, studentProfileId: profileId, effectiveFrom: "2030-03-01" });
    return templateId;
  }

  async function habitualReservation(templateId: string, localDate: string) {
    const sessionId = await createSession(localDate);
    await client.query("update class_sessions set template_id = $1 where id = $2", [templateId, sessionId]);
    const reservation = await academicService.createReservationForCurrentStudent(student, sessionId);
    return { ...reservation, classSessionId: sessionId };
  }

  it("selects the version from Copenhagen midnight, restricts publication and preserves its audit", async () => {
    const { getCurrentAcademicRegulation, getAcademicRegulationHistory, publishAcademicRegulation } = regulationService;
    await expect(getCurrentAcademicRegulation(null)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(getCurrentAcademicRegulation(student)).resolves.toMatchObject({ id: "initial", ...INITIAL_REGULATION });
    await expect(getCurrentAcademicRegulation(admin)).resolves.toMatchObject({ id: "initial" });
    await expect(getAcademicRegulationHistory(student)).rejects.toMatchObject({ code: "forbidden" });
    await expect(publishAcademicRegulation(student, nextRules)).rejects.toMatchObject({ code: "forbidden" });
    await expect(publishAcademicRegulation(null, nextRules)).rejects.toMatchObject({ code: "forbidden" });
    await expect(publishAcademicRegulation(admin, { ...nextRules, effectiveFrom: "2030-04-01" }))
      .rejects.toMatchObject({ code: "regulation_date_in_past" });
    await expect(publishAcademicRegulation(admin, { ...nextRules, maxClassCapacity: 13 }))
      .rejects.toMatchObject({ code: "invalid_regulation" });

    const published = await publishAcademicRegulation(admin, nextRules);
    await expect(publishAcademicRegulation(admin, nextRules)).rejects.toMatchObject({ code: "regulation_date_conflict" });
    const [entry, initial] = await getAcademicRegulationHistory(admin);
    expect(entry).toMatchObject({
      publisherEmail: "admin@example.com",
      version: {
        ...nextRules,
        id: published.id,
        previousVersionId: "initial",
        publishedByUserId: admin.userId,
        publishedAt: new Date("2030-04-01T10:00:00Z"),
        changes: {
          cancellationNoticeDays: { previous: 7, next: 10 },
          monthlyCancellationCredits: { previous: 2, next: 1 },
          monthlyRecoveries: { previous: 2, next: 1 },
          creditExpirationMonths: { previous: 6, next: 3 },
          maxClassCapacity: { previous: 12, next: 2 },
        },
      },
    });
    expect(initial.version.id).toBe("initial");
    await expect(client.query("update academic_regulations set max_class_capacity = 1 where id = $1", [published.id]))
      .rejects.toMatchObject({ code: "55000" });

    vi.setSystemTime(new Date("2030-04-01T21:59:59Z"));
    await expect(getCurrentAcademicRegulation(student)).resolves.toMatchObject({ id: "initial" });
    vi.setSystemTime(new Date("2030-04-01T22:00:00Z"));
    for (const actor of [student, admin]) {
      await expect(getCurrentAcademicRegulation(actor)).resolves.toEqual({ id: published.id, ...nextRules });
    }
  });

  it("rejects a one-off capacity above the effective regulation even below 12", async () => {
    const version = await regulationService.publishAcademicRegulation(admin, nextRules);
    vi.setSystemTime(new Date("2030-04-02T10:00:00Z"));
    const payload = { localDate: "2030-04-10", startsAtLocalTime: "18:25", durationMinutes: 60 };
    await expect(academicService.createOneOffClassSession(admin, { ...payload, maxCapacity: 3 }))
      .rejects.toMatchObject({ code: "regulation_capacity_exceeded" });

    const { classSessionId } = await academicService.createOneOffClassSession(admin, { ...payload, maxCapacity: 2 });
    const { rows } = await client.query("select id, max_capacity, regulation_version_id from class_sessions");
    expect(rows).toEqual([{ id: classSessionId, max_capacity: 2, regulation_version_id: version.id }]);
  });

  it("keeps prior booking and cancellation decisions while applying the new limit, capacity and notice", async () => {
    const oldSessionId = await createSession("2030-04-10");
    const otherSessionId = await createSession("2030-04-11");
    const blockSessionId = await createSession("2030-04-12");
    const templateId = await createHabitualTemplate();
    for (const date of ["2030-04-08", "2030-04-09"]) {
      await academicService.cancelReservation(student, await habitualReservation(templateId, date));
    }
    const originalCancellation = await academicService.cancelReservation(student, await habitualReservation(templateId, "2030-04-10"));
    expect(originalCancellation).toMatchObject({
      regulationVersionId: "initial", cancellationType: "ON_TIME", autoCreditGenerated: true,
    });
    if (!("cancellationId" in originalCancellation)) throw new Error("Expected an ordinary cancellation");

    await creditService.grantManualCredits(admin, { studentProfileId: profileId, amount: 3, reason: "Test credits" });
    const booking = await recoveryService.reserveRecovery(student, { classSessionId: oldSessionId });
    const before = await recoveryService.getRecoveryHistory(student);
    const originalLedger = (await creditService.getCreditOverview(student)).history;
    expect(originalLedger).toContainEqual(expect.objectContaining({
      movementType: "AUTO_CANCELLATION_GRANT",
      regulationVersionId: "initial",
      expiresAt: new Date("2030-10-01T10:00:00Z"),
    }));
    const newVersion = await regulationService.publishAcademicRegulation(admin, nextRules);
    expect(await recoveryService.getRecoveryHistory(student)).toEqual(before);

    vi.setSystemTime(new Date("2030-04-02T09:00:00Z"));
    await expect(recoveryService.reserveRecovery(student, { classSessionId: otherSessionId }))
      .rejects.toMatchObject({ code: "monthly_recovery_limit_reached" });
    await expect(academicService.createReservation(admin, {
      classSessionId: otherSessionId, studentProfileId: profileId, origin: "MAKEUP",
    })).rejects.toMatchObject({ code: "monthly_recovery_limit_reached" });
    await expect(recoveryService.cancelRecoveryReservation(student, { reservationId: booking.reservationId }))
      .resolves.toMatchObject({ cancelled: true, refunded: false });

    await academicService.addSessionCapacityBlock(admin, { classSessionId: blockSessionId, blockedSpots: 1 });
    await academicService.createReservationForCurrentStudent(student, blockSessionId);
    await expect(academicService.addSessionCapacityBlock(admin, { classSessionId: blockSessionId, blockedSpots: 1 }))
      .rejects.toMatchObject({ code: "capacity_conflict" });
    expect(await academicService.getClassSessionAvailability(blockSessionId))
      .toMatchObject({ capacity: 2, blockedSpots: 1, confirmedReservations: 1, availableSpots: 0 });

    const after = await recoveryService.getRecoveryHistory(student);
    expect(after.reservations).toEqual([{
      ...before.reservations[0],
      cancelledAt: new Date("2030-04-02T09:00:00Z"),
      status: "CANCELLED",
      regulationVersionId: "initial",
      cancellationRegulationVersionId: newVersion.id,
    }]);
    expect(after.ledgerRows).toEqual(before.ledgerRows);
    expect((await creditService.getCreditOverview(student)).history).toEqual(originalLedger);
    const activity = await academicService.getStudentActivityHistory(student);
    expect(activity.cancellations.find(({ id }) => id === originalCancellation.cancellationId)).toMatchObject({
      id: originalCancellation.cancellationId,
      regulationVersionId: "initial",
      cancellationType: "ON_TIME",
      canGenerateCreditCandidate: true,
    });
    expect((await client.query("select max_capacity, regulation_version_id from class_sessions where id = $1", [blockSessionId])).rows)
      .toEqual([{ max_capacity: 12, regulation_version_id: "initial" }]);
  });

  it("preserves the prior grant when an out-of-order cancellation takes the third position", async () => {
    const templateId = await createHabitualTemplate();
    await academicService.cancelReservation(student, await habitualReservation(templateId, "2030-04-10"));
    await academicService.cancelReservation(student, await habitualReservation(templateId, "2030-04-11"));
    const first = await academicService.cancelReservation(student, await habitualReservation(templateId, "2030-04-14"));
    expect(first).toMatchObject({ autoCreditGenerated: true, regulationVersionId: "initial" });
    const before = await academicService.getStudentActivityHistory(student);
    const ledger = (await creditService.getCreditOverview(student)).history;

    await expect(academicService.cancelReservation(student, await habitualReservation(templateId, "2030-04-13")))
      .resolves.toMatchObject({ autoCreditGenerated: false, autoCreditSkippedReason: "SEQUENCE_ALREADY_CREDITED" });

    const after = await academicService.getStudentActivityHistory(student);
    expect(after.cancellations).toHaveLength(4);
    expect(after.cancellations).toEqual(expect.arrayContaining(before.cancellations));
    expect(after.cancellations.filter((row) => row.canGenerateCreditCandidate)).toHaveLength(1);
    expect((await creditService.getCreditOverview(student)).history).toEqual(ledger);
  });

  it("keeps another available credit when a consumed automatic grant expires", async () => {
    const templateId = await createHabitualTemplate();
    for (const date of ["2030-04-10", "2030-04-11", "2030-04-12"]) {
      await academicService.cancelReservation(student, await habitualReservation(templateId, date));
    }
    const [grant] = (await creditService.getCreditOverview(student)).history;
    expect(grant).toMatchObject({ movementType: "AUTO_CANCELLATION_GRANT", regulationVersionId: "initial" });
    const recoverySession = await createSession("2030-04-13");
    const booking = await recoveryService.reserveRecovery(student, { classSessionId: recoverySession });
    expect(booking.consumedFromGrantMovementId).toBe(grant.id);
    await creditService.grantManualCredits(admin, { studentProfileId: profileId, amount: 1, reason: "Independent credit" });

    vi.setSystemTime(new Date("2030-10-02T10:00:00Z"));
    const overview = await creditService.getCreditOverview(student);
    expect(overview.availableCredits).toBe(1);
    expect(overview.expiredCredits).toBe(0);
    expect(overview.history).toHaveLength(3);
    expect(await recoveryService.getRecoveryAvailabilityForSession(student, recoverySession))
      .toMatchObject({ availableCredits: 1 });
    expect(await creditService.getCreditOverview(student)).toEqual(overview);
  });

  it("uses the cancellation version for automatic credit caps and expiration without charging for absences", async () => {
    const templateId = await createHabitualTemplate();
    const version = await regulationService.publishAcademicRegulation(admin, nextRules);
    vi.setSystemTime(new Date("2030-04-02T10:00:00Z"));

    const late = await habitualReservation(templateId, "2030-04-05");
    await expect(academicService.cancelReservation(student, late)).resolves
      .toMatchObject({ cancellationType: "LATE", autoCreditGenerated: false });
    const absence = await habitualReservation(templateId, "2030-04-06");
    vi.setSystemTime(new Date("2030-04-07T10:00:00Z"));
    await academicService.recordAttendance(admin, { ...absence, outcome: "ABSENT" });
    for (const localDate of ["2030-04-17", "2030-04-18", "2030-04-19"]) {
      await academicService.cancelReservation(student, await habitualReservation(templateId, localDate));
    }
    const attended = await habitualReservation(templateId, "2030-04-20");
    vi.setSystemTime(new Date("2030-04-21T10:00:00Z"));
    await academicService.recordAttendance(admin, { ...attended, outcome: "ATTENDED" });
    for (const localDate of ["2030-05-01", "2030-05-02"]) {
      await academicService.cancelReservation(student, await habitualReservation(templateId, localDate));
    }
    const capped = await academicService.cancelReservation(student, await habitualReservation(templateId, "2030-05-03"));
    expect(capped).toMatchObject({ autoCreditGenerated: false, autoCreditSkippedReason: "MONTHLY_LIMIT" });

    const activity = await academicService.getStudentActivityHistory(student);
    expect(activity.cancellations.filter((row) => row.sequencePosition === 3)).toHaveLength(2);
    expect(activity.cancellations.find((row) => row.sequencePosition === 4)?.canGenerateCreditCandidate).toBe(false);
    expect(activity.attendance.find((row) => row.outcome === "ABSENT")?.regulationVersionId).toBe(version.id);
    const overview = await creditService.getCreditOverview(student);
    expect(overview.history).toMatchObject([{
      movementType: "AUTO_CANCELLATION_GRANT",
      regulationVersionId: version.id,
      expiresAt: new Date("2030-07-07T10:00:00Z"),
    }]);
    vi.setSystemTime(new Date("2030-07-08T10:00:00Z"));
    const expired = await creditService.getCreditOverview(student);
    expect(expired.history).toMatchObject([
      { movementType: "AUTO_CANCELLATION_GRANT", regulationVersionId: version.id },
      { movementType: "EXPIRATION", regulationVersionId: version.id },
    ]);
    expect(await regulationService.resolveAcademicRegulation(db, "2030-04-01")).toMatchObject({ id: "initial" });
  });
});

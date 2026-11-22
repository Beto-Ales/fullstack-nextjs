import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe("academic regulation (postgres)", () => {
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
      await expect(getCurrentAcademicRegulation(actor)).resolves.toEqual({
        id: published.id, ...nextRules, maxEligibleConsecutiveCancellations: null,
      });
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

    await creditService.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId: profileId, amount: 3, reason: "Test credits" });
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

    await academicService.addSessionCapacityBlock(admin, { classSessionId: blockSessionId, blockId: randomUUID(), blockedSpots: 1, reason: "Bloqueo de prueba" });
    await academicService.createReservationForCurrentStudent(student, blockSessionId);
    await expect(academicService.addSessionCapacityBlock(admin, { classSessionId: blockSessionId, blockId: randomUUID(), blockedSpots: 1, reason: "Bloqueo de prueba" }))
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

  it("preserves a legacy decision when an earlier confirmed class is cancelled later", async () => {
    const templateId = await createHabitualTemplate();
    await academicService.cancelReservation(student, await habitualReservation(templateId, "2030-04-10"));
    await academicService.cancelReservation(student, await habitualReservation(templateId, "2030-04-12"));
    const pending = await habitualReservation(templateId, "2030-04-15");
    const future = await habitualReservation(templateId, "2030-04-18");

    const credited = await academicService.cancelReservation(student, future);
    expect(credited).toMatchObject({ autoCreditGenerated: true, regulationVersionId: "initial" });
    const before = await academicService.getStudentActivityHistory(student);
    const decision = before.cancellations.find(({ classSessionId }) => classSessionId === future.classSessionId);
    expect(decision).toMatchObject({ sequencePosition: 3, canGenerateCreditCandidate: true });
    const { history } = await creditService.getCreditOverview(student);
    expect(history).toHaveLength(1);

    vi.setSystemTime(new Date("2030-04-14T10:00:00Z"));
    await expect(academicService.cancelReservation(student, pending))
      .resolves.toMatchObject({ cancellationType: "LATE", autoCreditGenerated: false });
    const after = await academicService.getStudentActivityHistory(student);
    expect(after.currentConsecutiveCancellations).toBe(4);
    expect(after.cancellations.find(({ classSessionId }) => classSessionId === future.classSessionId)).toEqual(decision);
    expect((await creditService.getCreditOverview(student)).history).toEqual(history);
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
    await creditService.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId: profileId, amount: 1, reason: "Independent credit" });

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

  it("resolves the racha by session, awards the request month in request order, and expires from actual generation", async () => {
    const revised = await regulationService.publishAcademicRegulation(admin, {
      ...INITIAL_REGULATION, effectiveFrom: "2030-04-02", maxEligibleConsecutiveCancellations: 3,
    });
    const next = await regulationService.publishAcademicRegulation(admin, {
      ...INITIAL_REGULATION, effectiveFrom: "2030-05-01", maxEligibleConsecutiveCancellations: 1,
      monthlyCancellationCredits: 1, creditExpirationMonths: 3,
    });
    vi.setSystemTime(new Date("2030-04-30T21:56:00Z"));
    const template = await createHabitualTemplate();
    const blocker = await habitualReservation(template, "2030-05-06");
    const targets = [];
    for (const date of ["2030-05-23", "2030-05-16", "2030-05-09"]) {
      targets.push(await habitualReservation(template, date));
    }
    const requests = ["21:57", "21:58", "21:59"].map((time) => new Date(`2030-04-30T${time}:00Z`));
    for (const [index, target] of targets.entries()) {
      vi.setSystemTime(requests[index]);
      await expect(academicService.cancelReservation(student, target)).resolves.toMatchObject({
        cancellationType: "ON_TIME", autoCreditGenerated: false, autoCreditSkippedReason: "PENDING", regulationVersionId: revised.id,
      });
    }
    await expect(academicService.cancelReservation(student, targets[0]))
      .rejects.toMatchObject({ code: "reservation_not_confirmed" });
    const pending = await academicService.getStudentActivityHistory(student);
    expect(pending.currentConsecutiveCancellations).toBeNull();
    expect(pending.cancellations.map((row) => row.sequencePending)).toEqual([true, true, true]);
    expect((await creditService.getCreditOverview(student)).availableCredits).toBe(0);
    await expect(recoveryService.reserveRecovery(student, { classSessionId: await createSession("2030-05-24") }))
      .rejects.toMatchObject({ code: "no_available_credits" });

    const generated = new Date("2030-05-07T10:00:00Z");
    vi.setSystemTime(generated);
    await Promise.all([
      academicService.recordAttendance(admin, { ...blocker, outcome: "ABSENT" }),
      creditService.getCreditOverview(student),
      academicService.recordAttendance(admin, { ...blocker, outcome: "ABSENT" }),
    ]);
    const resolved = await academicService.getStudentActivityHistory(student);
    expect(resolved.cancellations.map((row) => [
      row.cancelledAt, row.sequencePosition, row.sequencePending, row.creditResolution, row.canGenerateCreditCandidate,
    ])).toEqual([
      [requests[0], 3, false, "GRANTED", true],
      [requests[1], 2, false, "GRANTED", true],
      [requests[2], 1, false, "MONTHLY_LIMIT", true],
    ]);
    const aprilGrants = (await creditService.getCreditOverview(student)).history;
    expect(aprilGrants).toHaveLength(2);
    expect(aprilGrants).toEqual(expect.arrayContaining(targets.slice(0, 2).map((target) => expect.objectContaining({
      classSessionId: target.classSessionId, createdAt: generated, expiresAt: new Date("2030-11-07T11:00:00Z"),
      regulationVersionId: revised.id,
    }))));
    await academicService.correctAttendance(admin, { ...blocker, outcome: "PRESENT", reason: "Verificación posterior" });
    expect((await creditService.getCreditOverview(student)).history).toEqual(aprilGrants);

    const reset = await habitualReservation(template, "2030-05-24");
    vi.setSystemTime(new Date("2030-05-25T10:00:00Z"));
    await academicService.recordAttendance(admin, { ...reset, outcome: "PRESENT" });
    const juneClass = await habitualReservation(template, "2030-06-03");
    await expect(academicService.cancelReservation(student, juneClass)).resolves.toMatchObject({
      autoCreditGenerated: true, regulationVersionId: next.id,
    });
    const overview = await creditService.getCreditOverview(student);
    expect(overview.availableCredits).toBe(3);
    expect(overview.history[2]).toMatchObject({ classSessionId: juneClass.classSessionId, regulationVersionId: next.id });
  });

  it("counts a late cancellation, keeps administrative decisions neutral, and resets on recorded attendance and absence", async () => {
    await regulationService.publishAcademicRegulation(admin, {
      ...INITIAL_REGULATION, effectiveFrom: "2030-04-02", maxEligibleConsecutiveCancellations: 3,
    });
    vi.setSystemTime(new Date("2030-04-02T10:00:00Z"));
    const template = await createHabitualTemplate();
    const dates = [];
    for (const date of ["2030-04-10", "2030-04-11", "2030-04-13", "2030-04-15", "2030-04-24", "2030-05-01"]) {
      dates.push(await habitualReservation(template, date));
    }
    const [first, second, adminDate, late, fourth, fifth] = dates;
    expect(await academicService.cancelReservation(student, first)).toMatchObject({ autoCreditGenerated: true });
    expect(await academicService.cancelReservation(student, second)).toMatchObject({ autoCreditGenerated: true });
    await expect(academicService.cancelSessionEnrollment(admin, {
      ...adminDate, cancellationId: randomUUID(), reason: "Ajuste de la escuela",
    })).resolves.toMatchObject({ autoCreditGenerated: false });
    expect(await academicService.cancelReservation(student, fourth)).toMatchObject({ autoCreditSkippedReason: "PENDING" });
    vi.setSystemTime(new Date("2030-04-14T10:00:00Z"));
    expect(await academicService.cancelReservation(student, late)).toMatchObject({ autoCreditGenerated: false, cancellationType: "LATE" });
    expect(await academicService.cancelReservation(student, fifth)).toMatchObject({ autoCreditGenerated: false });
    const after = await academicService.getStudentActivityHistory(student);
    expect(after.cancellations.filter((row) => row.sequencePosition !== null).map((row) => row.sequencePosition).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(after.cancellations.find((row) => row.classSessionId === fourth.classSessionId))
      .toMatchObject({ sequencePosition: 4, nonEligibilityReason: "SEQUENCE_POSITION", creditResolution: "NOT_ELIGIBLE" });
    expect(after.cancellations.find((row) => row.classSessionId === adminDate.classSessionId))
      .toMatchObject({ sequencePosition: null, creditResolution: null, sequencePending: false });
    expect(after.cancellations.find((row) => row.classSessionId === late.classSessionId))
      .toMatchObject({ sequencePosition: 3, nonEligibilityReason: "TIMING" });

    const attended = await habitualReservation(template, "2030-05-04");
    vi.setSystemTime(new Date("2030-05-05T10:00:00Z"));
    await academicService.recordAttendance(admin, { ...attended, outcome: "PRESENT" });
    expect((await academicService.getStudentActivityHistory(student)).currentConsecutiveCancellations).toBe(0);
    expect(await academicService.cancelReservation(student, await habitualReservation(template, "2030-05-13")))
      .toMatchObject({ autoCreditGenerated: true });
    const absent = await habitualReservation(template, "2030-05-15");
    const waiting = await habitualReservation(template, "2030-05-30");
    expect(await academicService.cancelReservation(student, waiting)).toMatchObject({ autoCreditSkippedReason: "PENDING" });
    vi.setSystemTime(new Date("2030-05-16T10:00:00Z"));
    await expect(academicService.detectAbsences(admin, {})).resolves.toMatchObject({ createdAbsences: 1 });
    const history = await academicService.listStudentClassHistory(student, new Date());
    expect(history.history.find((row) => row.reservationId === absent.reservationId)).toMatchObject({ attendanceOutcome: "ABSENT" });
    expect(history.history.find((row) => row.reservationId === waiting.reservationId)).toMatchObject({ sequencePending: false });
    expect((await academicService.getStudentActivityHistory(student)).cancellations.find((row) => row.classSessionId === waiting.classSessionId))
      .toMatchObject({ sequencePosition: 1, creditResolution: "GRANTED" });
    expect((await creditService.getCreditOverview(student)).availableCredits).toBe(4);
  });

  it("does not let a later request with known position take the last monthly slot from an older pending request", async () => {
    await regulationService.publishAcademicRegulation(admin, {
      ...INITIAL_REGULATION, effectiveFrom: "2030-04-02", maxEligibleConsecutiveCancellations: 3,
      monthlyCancellationCredits: 1,
    });
    vi.setSystemTime(new Date("2030-04-10T10:00:00Z"));
    const template = await createHabitualTemplate();
    const earlySession = await habitualReservation(template, "2030-04-18");
    const blocker = await habitualReservation(template, "2030-04-20");
    const lateSession = await habitualReservation(template, "2030-04-27");
    expect(await academicService.cancelReservation(student, lateSession)).toMatchObject({ autoCreditSkippedReason: "PENDING" });
    vi.setSystemTime(new Date("2030-04-11T10:00:00Z"));
    expect(await academicService.cancelReservation(student, earlySession)).toMatchObject({ autoCreditSkippedReason: "PENDING" });
    vi.setSystemTime(new Date("2030-04-21T10:00:00Z"));
    await academicService.recordAttendance(admin, { ...blocker, outcome: "ABSENT" });
    const { cancellations } = await academicService.getStudentActivityHistory(student);
    expect(cancellations).toMatchObject([
      { classSessionId: lateSession.classSessionId, sequencePosition: 1, creditResolution: "GRANTED" },
      { classSessionId: earlySession.classSessionId, sequencePosition: 1, creditResolution: "MONTHLY_LIMIT" },
    ]);
    const overview = await creditService.getCreditOverview(student);
    expect(overview.history).toMatchObject([{ classSessionId: lateSession.classSessionId }]);
  });

  it("activates the corrected rule after scheduled legacy versions and inherits the configured threshold", async () => {
    const legacy = await regulationService.publishAcademicRegulation(admin, { ...nextRules, effectiveFrom: "2030-05-01" });
    const revised = { ...nextRules, maxEligibleConsecutiveCancellations: 3 };
    await expect(regulationService.publishAcademicRegulation(admin, revised))
      .rejects.toMatchObject({ code: "regulation_sequence_date_conflict" });
    await expect(regulationService.publishAcademicRegulation(admin, { ...revised, effectiveFrom: "2030-05-02" }))
      .resolves.toMatchObject({
        previousVersionId: legacy.id,
        changes: { maxEligibleConsecutiveCancellations: { previous: null, next: 3 } },
      });
    await expect(regulationService.publishAcademicRegulation(admin, {
      ...nextRules, effectiveFrom: "2030-05-03", monthlyCancellationCredits: 2,
    })).resolves.toMatchObject({ maxEligibleConsecutiveCancellations: 3 });
    expect(await regulationService.resolveAcademicRegulation(db, "2030-05-01")).toMatchObject({
      id: legacy.id, maxEligibleConsecutiveCancellations: null,
    });
  });

  it("re-evaluates after a session moves past a pending cancellation without recalculating notice", async () => {
    const version = await regulationService.publishAcademicRegulation(admin, {
      ...INITIAL_REGULATION, effectiveFrom: "2030-04-02", maxEligibleConsecutiveCancellations: 3,
    });
    vi.setSystemTime(new Date("2030-04-02T10:00:00Z"));
    const template = await createHabitualTemplate();
    const blocker = await habitualReservation(template, "2030-04-12");
    const target = await habitualReservation(template, "2030-04-17");
    await expect(academicService.cancelReservation(student, target)).resolves.toMatchObject({ autoCreditSkippedReason: "PENDING" });
    vi.setSystemTime(new Date("2030-04-16T10:00:00Z"));
    await academicService.updateClassSession(admin, {
      classSessionId: blocker.classSessionId,
      startsAtUtc: new Date("2030-04-19T16:00:00Z"),
      endsAtUtc: new Date("2030-04-19T17:00:00Z"),
    });
    const { cancellations } = await academicService.getStudentActivityHistory(student);
    expect(cancellations[0]).toMatchObject({
      cancelledAt: new Date("2030-04-02T10:00:00Z"), cancellationType: "ON_TIME", creditResolution: "GRANTED",
    });
    expect((await creditService.getCreditOverview(student)).history).toMatchObject([{
      classSessionId: target.classSessionId, createdAt: new Date("2030-04-16T10:00:00Z"), regulationVersionId: version.id,
    }]);
  });
});

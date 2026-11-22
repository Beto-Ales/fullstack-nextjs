import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe("admin student profile (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let getProfile: typeof import("./admin-student-profile-service").getAdminStudentProfile;
  let academic: typeof import("./academic-service");
  let getCreditOverview: typeof import("../credits/credit-service").getCreditOverview;
  let withdrawStudent: typeof import("./student-withdrawal").withdrawStudent;
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" } as const;
  const student = { userId: randomUUID(), role: "STUDENT" } as const;
  const studentProfileId = randomUUID();
  const now = new Date("2031-01-20T16:00:00Z");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    ({ getAdminStudentProfile: getProfile } = await import("./admin-student-profile-service"));
    ({ getCreditOverview } = await import("../credits/credit-service"));
    ({ withdrawStudent } = await import("./student-withdrawal"));
    academic = await import("./academic-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    vi.setSystemTime(now);
    await client.query(`insert into users (id, email, email_normalized, password_hash, role)
      values ($1, 'admin@example.com', 'admin@example.com', 'admin-hash', 'SUPER_ADMIN'),
      ($2, 'maria@example.com', 'maria@example.com', 'private-student-hash', 'STUDENT')`, [admin.userId, student.userId]);
    await client.query(`insert into student_profiles (id, user_id, first_name, last_name, contact_phone, contact_email)
      values ($1, $2, 'María', 'Soler', '+45 12345678', 'contact@example.com')`, [studentProfileId, student.userId]);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await client?.end(); });

  async function reserve(date: string, {
    templateId = null, origin = "ORDINARY", status = "CONFIRMED", sessionStatus = "SCHEDULED",
  }: { templateId?: string | null; origin?: "ORDINARY" | "MAKEUP"; status?: "CONFIRMED" | "CANCELLED";
    sessionStatus?: "SCHEDULED" | "CANCELLED" | "COMPLETED" } = {}) {
    const sessionId = randomUUID();
    const reservationId = randomUUID();
    await client.query(`insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity)
      values ($1, $2, $3::date, $3::date + time '16:00' at time zone 'UTC',
        $3::date + time '17:00' at time zone 'UTC', $4, 12)`, [sessionId, templateId, date, sessionStatus]);
    await client.query(`insert into class_reservations (id, class_session_id, student_profile_id, origin, status)
      values ($1, $2, $3, $4, $5)`, [reservationId, sessionId, studentProfileId, origin, status]);
    return { classSessionId: sessionId, reservationId };
  }

  async function createAssignment() {
    const templateId = randomUUID();
    await client.query(`insert into class_templates
      (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
      values ($1, 'Acuarela semanal', 5, '17:00', 60, '2031-01-01')`, [templateId]);
    await client.query(`insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
      values ($1, $2, $3, '2030-12-30')`, [randomUUID(), studentProfileId, templateId]);
    return templateId;
  }

  it("requires SUPER_ADMIN before looking up a valid student identifier and returns only account details", async () => {
    await expect(getProfile(student, studentProfileId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getProfile(student, "invalid")).rejects.toMatchObject({ code: "forbidden" });
    await expect(getProfile(admin, "invalid")).resolves.toBeNull();
    await expect(getProfile(admin, randomUUID())).resolves.toBeNull();
    await expect(getProfile(admin, student.userId)).resolves.toBeNull();

    const profile = await getProfile(admin, studentProfileId);
    expect(profile?.student).toEqual({
      id: studentProfileId, firstName: "María", lastName: "Soler", email: "maria@example.com",
      contactEmail: "contact@example.com", contactPhone: "+45 12345678", status: "ACTIVE",
      createdAt: expect.any(Date), deactivatedAt: null,
    });
    expect(JSON.stringify(profile)).not.toMatch(/password|private-student-hash|sessionToken/i);
    expect(profile?.upcoming.items).toEqual([]);
    expect(profile?.credits.availableCredits).toBe(0);
  });

  it("keeps weekly assignments and confirmed future bookings separate from cancellations", async () => {
    const templateId = await createAssignment();
    const habitual = await reserve("2031-01-24", { templateId });
    const ordinary = await reserve("2031-01-25");
    const recovery = await reserve("2031-01-26", { origin: "MAKEUP" });
    const cancelled = await reserve("2031-01-27");
    await academic.cancelSessionEnrollment(admin, {
      ...cancelled, cancellationId: randomUUID(), reason: "Cierre administrativo",
    });
    const cancelledClass = await reserve("2031-01-28", { sessionStatus: "CANCELLED" });
    const auditedClass = await reserve("2031-01-30");
    await academic.cancelClassSession(admin, { classSessionId: auditedClass.classSessionId });
    const inconsistent = await reserve("2031-01-29");
    await client.query(`insert into reservation_cancellations (id, reservation_id, student_profile_id,
      class_session_id, cancelled_at, cancellation_type, hours_before_start, meets_seven_day_rule, is_habitual_reservation)
      values ($1, $2, $3, $4, $5, 'ON_TIME', 200, true, false)`,
    [randomUUID(), inconsistent.reservationId, studentProfileId, inconsistent.classSessionId, now]);

    const profile = await getProfile(admin, studentProfileId);
    expect(profile?.schedules.items).toMatchObject([{
      courseName: "Acuarela semanal", isoWeekday: 5, startsAtLocalTime: "17:00:00", assignmentStatus: "ACTIVE", effectiveFrom: "2031-01-01",
    }]);
    expect(profile?.upcoming.items).toMatchObject([
      { reservationId: habitual.reservationId, habitual: true, origin: "ORDINARY" },
      { reservationId: ordinary.reservationId, habitual: false, origin: "ORDINARY" },
      { reservationId: recovery.reservationId, origin: "MAKEUP" },
    ]);
    expect(profile?.history.items).toMatchObject([
      { reservationId: auditedClass.reservationId, sessionCancellation: true },
      { reservationId: inconsistent.reservationId, cancellationSource: null, cancellationType: "ON_TIME" },
      { reservationId: cancelledClass.reservationId, sessionStatus: "CANCELLED", sessionCancellation: false },
      { reservationId: cancelled.reservationId, cancellationSource: "ADMIN_DECISION", cancellationActorEmail: "admin@example.com",
        administrativeReason: "Cierre administrativo" },
    ]);
  });

  it("counts corrected attendance and distinct cancellation sources across history pages", async () => {
    const attended = await reserve("2031-01-13");
    const absent = await reserve("2031-01-12");
    await academic.recordAttendance(admin, { ...attended, outcome: "ABSENT" });
    await academic.correctAttendance(admin, { ...attended, outcome: "PRESENT", reason: "Se verificó la asistencia" });
    await academic.recordAttendance(admin, { ...absent, outcome: "ABSENT" });
    const early = await reserve("2031-02-12");
    const late = await reserve("2031-01-21");
    const adminCancellation = await reserve("2031-02-11");
    await academic.cancelReservation(student, { reservationId: early.reservationId });
    await academic.cancelReservation(student, { reservationId: late.reservationId });
    await academic.cancelSessionEnrollment(admin, { ...adminCancellation, cancellationId: randomUUID(), reason: "Decisión administrativa" });
    const legacy = await reserve("2031-01-15", { status: "CANCELLED" });
    await client.query("update class_reservations set cancelled_by_user_id = $1 where id = $2", [admin.userId, legacy.reservationId]);
    const tied = [];
    for (let index = 0; index < 22; index++) tied.push(await reserve("2031-01-01"));

    const first = await getProfile(admin, studentProfileId);
    const second = await getProfile(admin, studentProfileId, { historial: "2", proximas: ["2"], movimientos: "-1" });
    expect(first?.history.hasNext).toBe(true);
    expect(first?.history.items).toHaveLength(20);
    expect(second?.history).toMatchObject({ number: 2, hasNext: false });
    expect(second?.upcoming.number).toBe(1);
    expect(second?.movements.number).toBe(1);
    expect(first?.totals).toEqual({ attended: 1, absent: 1, studentCancellations: 2, adminCancellations: 1, recoveries: 0 });
    expect(second?.totals).toEqual(first?.totals);
    expect(first?.history.items.slice(0, 6)).toMatchObject([
      { reservationId: early.reservationId, cancellationSource: "STUDENT_REQUEST", cancellationType: "ON_TIME", attendanceOutcome: null },
      { reservationId: adminCancellation.reservationId, cancellationSource: "ADMIN_DECISION" },
      { reservationId: late.reservationId, cancellationSource: "STUDENT_REQUEST", cancellationType: "LATE" },
      { reservationId: legacy.reservationId, cancellationSource: null, administrativeReason: null, cancellationActorEmail: "admin@example.com" },
      { reservationId: attended.reservationId, attendanceOutcome: "ATTENDED", correctionReason: "Se verificó la asistencia" },
      { reservationId: absent.reservationId, attendanceOutcome: "ABSENT" },
    ]);
    const ids = [...first!.history.items, ...second!.history.items].map(({ reservationId }) => reservationId);
    expect(ids.slice(6)).toEqual(tied.map(({ reservationId }) => reservationId).sort().reverse());
    expect(new Set(ids).size).toBe(28);
  });

  it("reads credit expiry and recovery movements from the ledger, without writing through the profile", async () => {
    const future = await reserve("2031-02-20", { origin: "MAKEUP" });
    const attended = await reserve("2031-01-19", { origin: "MAKEUP" });
    const cancelled = await reserve("2031-02-21", { origin: "MAKEUP", status: "CANCELLED" });
    const grantId = randomUUID();
    const consumptionId = randomUUID();
    await academic.recordAttendance(admin, { ...attended, outcome: "PRESENT" });
    await client.query(`insert into credit_ledger_movements
      (id, student_profile_id, movement_type, amount, created_at, expires_at, source_grant_movement_id, idempotency_key)
      values ($1, $2, 'AUTO_CANCELLATION_GRANT', 1, '2030-01-01 00:00Z', '2030-12-31 00:00Z', $1, $1),
      ($3, $2, 'MANUAL_GRANT', 3, '2031-01-01 00:00Z', '2031-04-01 00:00Z', $3, $3)`, [randomUUID(), studentProfileId, grantId]);
    await client.query(`insert into credit_ledger_movements
      (id, student_profile_id, movement_type, amount, created_at, source_grant_movement_id,
        idempotency_key, related_reservation_id, source_movement_id, refund_restored_credit, reason)
      values ($1, $2, 'RECOVERY_CONSUMPTION', 1, '2031-01-02 00:00Z', $3, $1, $4, null, null, null),
      ($5, $2, 'RECOVERY_CONSUMPTION', 1, '2031-01-02 00:00Z', $3, $5, $6, null, null, null),
      ($7, $2, 'RECOVERY_CONSUMPTION', 1, '2031-01-02 00:00Z', $3, $7, $8, null, null, null),
      ($9, $2, 'RECOVERY_REFUND', 1, '2031-01-03 00:00Z', $3, $9, $8, $7, true, 'Devolución registrada')`,
    [randomUUID(), studentProfileId, grantId, future.reservationId, randomUUID(), attended.reservationId,
      consumptionId, cancelled.reservationId, randomUUID()]);
    const ledgerBefore = await client.query("select id from credit_ledger_movements order by id");
    const profile = await getProfile(admin, studentProfileId);
    expect(await client.query("select id from credit_ledger_movements order by id")).toEqual(ledgerBefore);
    const existing = await getCreditOverview(admin, { studentProfileId });
    expect(profile?.credits).toMatchObject({ availableCredits: existing.availableCredits, expiredCredits: existing.expiredCredits,
      usedCredits: 3, pendingExpirationUnits: 1, nextExpirations: existing.availableExpirations });
    expect(profile?.credits.expiredCredits).toBe(1);
    expect(profile?.credits.availableCredits).toBe(1);
    expect(profile?.movements.items).toHaveLength(6);
    expect(profile?.movements.items[0]).toMatchObject({ reason: "Devolución registrada", classSessionId: cancelled.classSessionId });
    expect(profile?.recoveries.items).toMatchObject([
      { reservationId: cancelled.reservationId, cancelled: true, movements: [
        { movementType: "RECOVERY_CONSUMPTION", amount: 1 }, { movementType: "RECOVERY_REFUND", refundRestoredCredit: true },
      ] },
      { reservationId: future.reservationId, cancelled: false, attendanceOutcome: null },
      { reservationId: attended.reservationId, attendanceOutcome: "ATTENDED" },
    ]);
    const refreshed = await getProfile(admin, studentProfileId);
    expect(refreshed?.credits.pendingExpirationUnits).toBe(0);
    expect(refreshed?.movements.items.filter(({ movementType }) => movementType === "EXPIRATION")).toHaveLength(1);
  });

  it("paginates ledger movements independently from recovery reservations with linked consumption", async () => {
    const grant = randomUUID();
    const movements = Array.from({ length: 21 }, () => randomUUID()).sort().reverse();
    const bookings = [];
    for (let index = 0; index < movements.length; index++) {
      bookings.push(await reserve("2031-04-01", { origin: "MAKEUP" }));
    }
    const reservations = bookings.map(({ reservationId }) => reservationId).sort().reverse();
    await client.query(`insert into credit_ledger_movements
      (id, student_profile_id, movement_type, amount, created_at, source_grant_movement_id, idempotency_key)
      values ($1, $2, 'MANUAL_GRANT', 21, '2031-01-18 00:00Z', $1, $1)`, [grant, studentProfileId]);
    await client.query(`insert into credit_ledger_movements
      (id, student_profile_id, movement_type, amount, created_at, source_grant_movement_id, idempotency_key, related_reservation_id)
      select movement, $1, 'RECOVERY_CONSUMPTION', 1, '2031-01-19 00:00Z', $2, movement, reservation
      from unnest($3::text[], $4::text[]) as entry(movement, reservation)`,
    [studentProfileId, grant, movements, reservations]);

    const profile = await getProfile(admin, studentProfileId, { recuperaciones: "2" });
    expect(profile?.recoveries).toMatchObject({ number: 2, hasNext: false, items: [{
      reservationId: reservations[20], movements: [{ id: movements[20], amount: 1 }],
    }] });
    expect(profile?.movements.items.map(({ id }) => id)).toEqual(movements.slice(0, 20));
    expect(profile?.movements.hasNext).toBe(true);
    expect(profile?.totals.recoveries).toBe(21);
    expect(profile?.credits).toMatchObject({ usedCredits: 21, availableCredits: 0 });
    const second = await getProfile(admin, studentProfileId, { movimientos: "2" });
    expect(second?.movements.items.map(({ id }) => id)).toEqual([movements[20], grant]);
    expect(second?.recoveries.items).toHaveLength(20);
    expect(second?.recoveries.hasNext).toBe(true);
  });

  it("keeps the recorded history, schedules and credits after a logical withdrawal", async () => {
    await createAssignment();
    const historical = await reserve("2031-01-19");
    const future = await reserve("2031-01-24");
    await academic.recordAttendance(admin, { ...historical, outcome: "PRESENT" });
    await withdrawStudent(admin, { studentProfileId });

    const profile = await getProfile(admin, studentProfileId);
    expect(profile?.student).toMatchObject({ status: "DISABLED", deactivatedAt: now });
    expect(profile?.schedules.items).toMatchObject([{ assignmentStatus: "ENDED", effectiveTo: "2031-01-20" }]);
    expect(profile?.upcoming.items).toEqual([]);
    expect(profile?.history.items).toMatchObject([
      { reservationId: future.reservationId, cancelled: true, cancellationSource: null, withdrawalCancellation: true },
      { reservationId: historical.reservationId, attendanceOutcome: "ATTENDED" },
    ]);
    expect(profile?.totals.attended).toBe(1);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { hashSessionToken } from "@/src/infrastructure/security/session-token";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

const request = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: request.token }) }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("attendance (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academic: typeof import("./academic-service");
  let actions: typeof import("@/src/interfaces/academic/actions");
  let recoveries: typeof import("@/src/application/recovery/recovery-service");

  const admin = { role: "SUPER_ADMIN", userId: randomUUID() } as const;
  const student = { role: "STUDENT", userId: randomUUID() } as const;
  const profileId = randomUUID();
  const target = { classSessionId: randomUUID(), reservationId: randomUUID() };
  const startsAt = new Date("2031-03-30T16:00:00.000Z");
  const endsAt = new Date("2031-03-30T17:30:00.000Z");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("./academic-service");
    actions = await import("@/src/interfaces/academic/actions");
    recoveries = await import("@/src/application/recovery/recovery-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    vi.setSystemTime(endsAt);
    await client.query(`
      insert into users (id, email, email_normalized, password_hash, role)
      values ($1, 'admin@example.com', 'admin@example.com', 'hash', 'SUPER_ADMIN'),
             ($2, 'student@example.com', 'student@example.com', 'hash', 'STUDENT')`, [admin.userId, student.userId]);
    await client.query(`
      insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Test', 'Student')`,
    [profileId, student.userId]);
    await seedSession(target.classSessionId);
    await client.query(`
      insert into class_reservations (id, class_session_id, student_profile_id) values ($1, $2, $3)`,
    [target.reservationId, target.classSessionId, profileId]);
  });

  afterEach(() => {
    request.token = undefined;
    vi.useRealTimers();
  });
  afterAll(async () => { await client?.end(); });

  async function seedSession(id: string) {
    await client.query(`
      insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
      values ($1, '2031-03-30', $2, $3, 12)`, [id, startsAt, endsAt]);
  }

  async function attendance() {
    const { rows } = await client.query(`
      select id, reservation_id, class_session_id, outcome, source, recorded_at, recorded_by_user_id,
             correction_reason, corrected_from_record_id, superseded_at, regulation_version_id
      from reservation_attendance_records where reservation_id = $1 order by recorded_at, id`, [target.reservationId]);
    return rows;
  }

  async function expectNoCreditOrCancellation() {
    const { rows } = await client.query(`
      select status, (select count(*)::int from credit_ledger_movements) as movements,
        (select count(*)::int from reservation_cancellations) as cancellations
      from class_reservations where id = $1`, [target.reservationId]);
    expect(rows).toEqual([{ status: "CONFIRMED", movements: 0, cancellations: 0 }]);
  }

  it.each([ ["PRESENT", "ATTENDED"], ["ABSENT", "ABSENT"] ])(
    "records %s at the exact end and repeats it without another write",
    async (outcome, stored) => {
      const input = { ...target, outcome };
      const first = await academic.recordAttendance(admin, input);
      expect(first.updated).toBe(true);
      const rows = await attendance();
      expect(rows).toMatchObject([{
        id: first.attendanceRecordId, reservation_id: target.reservationId, class_session_id: target.classSessionId,
        outcome: stored, source: "MANUAL", recorded_at: endsAt, recorded_by_user_id: admin.userId,
        correction_reason: null, corrected_from_record_id: null, superseded_at: null, regulation_version_id: "initial",
      }]);
      vi.setSystemTime(new Date(endsAt.getTime() + 1));
      await expect(academic.recordAttendance(admin, { ...input, outcome: stored }))
        .resolves.toEqual({ attendanceRecordId: first.attendanceRecordId, updated: false });
      expect(await attendance()).toEqual(rows);
      await expectNoCreditOrCancellation();
    },
  );

  it.each(["PRESENT", "ABSENT"])("rejects %s before start and one millisecond before end", async (outcome) => {
    for (const reference of [startsAt, endsAt]) {
      vi.setSystemTime(new Date(reference.getTime() - 1));
      const input = { ...target, outcome, referenceTimeUtc: endsAt };
      await expect(academic.recordAttendance(admin, input)).rejects.toMatchObject({ code: "session_not_ended" });
      await expect(academic.correctAttendance(admin, { ...input, reason: "Valid reason" }))
        .rejects.toMatchObject({ code: "session_not_ended" });
    }
    expect(await attendance()).toEqual([]);
  });

  it("validates identifiers, outcome, membership and existence in both operations", async () => {
    const otherSession = randomUUID();
    await seedSession(otherSession);
    for (const operation of [academic.recordAttendance, academic.correctAttendance]) {
      const input = { ...target, outcome: "PRESENT", reason: "Valid reason" };
      for (const overrides of [{ classSessionId: "invalid" }, { reservationId: "invalid" }, { outcome: "UNKNOWN" }]) {
        await expect(operation(admin, { ...input, ...overrides })).rejects.toMatchObject({ name: "ZodError" });
      }
      for (const overrides of [{ classSessionId: otherSession }, { classSessionId: randomUUID() }, { reservationId: randomUUID() }]) {
        await expect(operation(admin, { ...input, ...overrides })).rejects.toMatchObject({ code: "reservation_not_found" });
      }
    }
    expect(await attendance()).toEqual([]);
  });

  it.each([
    { table: "class_sessions", id: target.classSessionId, code: "session_cancelled" },
    { table: "class_reservations", id: target.reservationId, code: "reservation_not_confirmed" },
  ])("rejects both operations on a cancelled $table row", async ({ table, id, code }) => {
    await client.query(`update ${table} set status = 'CANCELLED' where id = $1`, [id]);
    await expect(academic.recordAttendance(admin, { ...target, outcome: "PRESENT" })).rejects.toMatchObject({ code });
    await expect(academic.correctAttendance(admin, { ...target, outcome: "ABSENT", reason: "Valid reason" }))
      .rejects.toMatchObject({ code });
    expect(await attendance()).toEqual([]);
  });

  it("enforces the role in both services and when invoking the server actions", async () => {
    const input = { ...target, outcome: "PRESENT", reason: "Valid reason" };
    await expect(academic.recordAttendance(student, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(academic.correctAttendance(student, input)).rejects.toMatchObject({ code: "forbidden" });

    await expect(actions.recordAttendanceAction(input)).rejects.toThrow("redirect:/login");
    request.token = randomUUID();
    await client.query(`
      insert into sessions (id, user_id, token_hash, expires_at) values ($1, $2, $3, $4)`,
    [randomUUID(), student.userId, hashSessionToken(request.token), new Date(endsAt.getTime() + 60_000)]);
    await expect(actions.recordAttendanceAction({ ...input, role: "SUPER_ADMIN" })).rejects.toThrow("redirect:/student");
    await expect(actions.correctAttendanceAction(input)).rejects.toThrow("redirect:/student");
    expect(await attendance()).toEqual([]);
  });

  it("requires a prior outcome and a reason, and traces corrections in both directions", async () => {
    const present = { ...target, outcome: "PRESENT" };
    const absent = { ...target, outcome: "ABSENT" };
    await expect(academic.correctAttendance(admin, { ...present, reason: "Valid reason" }))
      .rejects.toMatchObject({ code: "attendance_not_found" });
    const first = await academic.recordAttendance(admin, present);
    const original = await attendance();

    await expect(academic.recordAttendance(admin, absent)).rejects.toMatchObject({ code: "attendance_already_recorded" });
    for (const reason of [undefined, "   ", "ab", "a".repeat(301)]) {
      await expect(academic.correctAttendance(admin, { ...absent, reason })).rejects.toMatchObject({ name: "ZodError" });
    }
    await expect(academic.correctAttendance(admin, { ...present, reason: "Valid reason" }))
      .rejects.toMatchObject({ code: "attendance_same_outcome" });
    expect(await attendance()).toEqual(original);

    const firstCorrectionAt = new Date(endsAt.getTime() + 1000);
    vi.setSystemTime(firstCorrectionAt);
    const second = await academic.correctAttendance(admin, { ...absent, reason: "  Revised roll call  " });
    expect((await academic.listStudentClassHistory(student, firstCorrectionAt)).history)
      .toMatchObject([{ reservationId: target.reservationId, attendanceOutcome: "ABSENT", status: "CONFIRMED" }]);

    const secondCorrectionAt = new Date(endsAt.getTime() + 2000);
    vi.setSystemTime(secondCorrectionAt);
    const third = await academic.correctAttendance(admin, { ...present, reason: "Student verified" });
    expect(await attendance()).toMatchObject([
      { ...original[0], superseded_at: firstCorrectionAt },
      { id: second.attendanceRecordId, outcome: "ABSENT", recorded_at: firstCorrectionAt, recorded_by_user_id: admin.userId,
        corrected_from_record_id: first.attendanceRecordId, correction_reason: "Revised roll call", superseded_at: secondCorrectionAt },
      { id: third.attendanceRecordId, outcome: "ATTENDED", recorded_at: secondCorrectionAt, recorded_by_user_id: admin.userId,
        corrected_from_record_id: second.attendanceRecordId, correction_reason: "Student verified", superseded_at: null },
    ]);
    expect((await academic.listStudentClassHistory(student, secondCorrectionAt)).history)
      .toMatchObject([{ reservationId: target.reservationId, attendanceOutcome: "ATTENDED" }]);
    await expectNoCreditOrCancellation();
  });

  it("serializes simultaneous initial writes and two corrections of the same result", async () => {
    const present = { ...target, outcome: "PRESENT" };
    const registrations = await Promise.all(Array.from({ length: 3 }, () => academic.recordAttendance(admin, present)));
    expect(registrations.filter(({ updated }) => updated)).toHaveLength(1);
    expect(new Set(registrations.map(({ attendanceRecordId }) => attendanceRecordId)).size).toBe(1);

    vi.setSystemTime(new Date(endsAt.getTime() + 1000));
    const correction = { ...target, outcome: "ABSENT", reason: "Concurrent correction" };
    const changes = await Promise.allSettled([
      academic.correctAttendance(admin, correction), academic.correctAttendance(admin, correction),
    ]);
    expect(changes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(changes).toContainEqual(expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "attendance_same_outcome" }) }));
    expect(await attendance()).toMatchObject([
      { id: registrations[0].attendanceRecordId, superseded_at: expect.any(Date) },
      { outcome: "ABSENT", corrected_from_record_id: registrations[0].attendanceRecordId, superseded_at: null },
    ]);
  });

  it("serializes contradictory initial writes", async () => {
    const results = await Promise.allSettled(["ABSENT", "PRESENT"].map((outcome) =>
      academic.recordAttendance(admin, { ...target, outcome })));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results).toContainEqual(expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "attendance_already_recorded" }) }));
    expect(await attendance()).toMatchObject([{ superseded_at: null }]);
  });

  it("keeps one current result when an initial write and a correction race", async () => {
    const results = await Promise.allSettled([
      academic.recordAttendance(admin, { ...target, outcome: "PRESENT" }),
      academic.correctAttendance(admin, { ...target, outcome: "ABSENT", reason: "Concurrent correction" }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    const rows = await attendance();
    const current = rows.filter((row) => row.superseded_at === null);
    if (results[1].status === "fulfilled") {
      expect(current).toMatchObject([{ outcome: "ABSENT", corrected_from_record_id: expect.any(String) }]);
      expect(rows).toHaveLength(2);
    } else {
      expect(results[1].reason).toMatchObject({ code: "attendance_not_found" });
      expect(current).toMatchObject([{ outcome: "ATTENDED" }]);
      expect(rows).toHaveLength(1);
    }
  });

  it.each(["reservation", "session", "recovery"] as const)("keeps attendance exclusive with concurrent %s cancellation", async (kind) => {
    if (kind === "recovery") {
      await client.query("update class_reservations set origin = 'MAKEUP' where id = $1", [target.reservationId]);
    }
    const cancellation = kind === "session" ? academic.cancelClassSession(admin, target)
      : kind === "recovery" ? recoveries.cancelRecoveryReservation(student, target) : academic.cancelReservation(student, target);
    const results = await Promise.allSettled([cancellation, academic.recordAttendance(admin, { ...target, outcome: "ABSENT" })]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    if (results[0].status === "fulfilled") {
      expect(await attendance()).toEqual([]);
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: kind === "session" ? "session_cancelled" : "reservation_not_confirmed" } });
      if (kind === "reservation") {
        expect((await academic.listStudentClassHistory(student, endsAt)).history)
          .toMatchObject([{ status: "CANCELLED", cancellationType: "LATE", attendanceOutcome: null }]);
      }
    } else {
      expect(results[0].reason).toMatchObject({ code: "attendance_already_recorded" });
      expect(await attendance()).toMatchObject([{ outcome: "ABSENT", superseded_at: null }]);
      await expectNoCreditOrCancellation();
    }
  });

  it("rejects both reservation and session cancellations once attendance is recorded", async () => {
    await academic.recordAttendance(admin, { ...target, outcome: "PRESENT" });
    await expect(academic.cancelReservation(student, target)).rejects.toMatchObject({ code: "attendance_already_recorded" });
    await expect(academic.cancelClassSession(admin, target)).rejects.toMatchObject({ code: "attendance_already_recorded" });

    await client.query("update class_reservations set origin = 'MAKEUP' where id = $1", [target.reservationId]);
    await expect(recoveries.cancelRecoveryReservation(student, target)).rejects.toMatchObject({ code: "attendance_already_recorded" });
    await expectNoCreditOrCancellation();
    expect(await attendance()).toMatchObject([{ outcome: "ATTENDED", superseded_at: null }]);
    const { rows } = await client.query("select status from class_sessions where id = $1", [target.classSessionId]);
    expect(rows).toEqual([{ status: "SCHEDULED" }]);
  });

  it("uses the reprogrammed end and protects recorded attendance from later schedule changes", async () => {
    const movedEnd = new Date(endsAt.getTime() + 60_000);
    const results = await Promise.allSettled([
      academic.updateClassSession(admin, { ...target, endsAtUtc: movedEnd }),
      academic.recordAttendance(admin, { ...target, outcome: "PRESENT" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    if (results[0].status === "fulfilled") {
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "session_not_ended" } });
      expect(await attendance()).toEqual([]);
      vi.setSystemTime(movedEnd);
      await academic.recordAttendance(admin, { ...target, outcome: "PRESENT" });
    } else {
      expect(results[0].reason).toMatchObject({ code: "attendance_already_recorded" });
    }
    await expect(academic.updateClassSession(admin, { ...target, endsAtUtc: new Date(movedEnd.getTime() + 1000) }))
      .rejects.toMatchObject({ code: "attendance_already_recorded" });
    expect(await attendance()).toMatchObject([{ outcome: "ATTENDED", superseded_at: null }]);
  });

  it("shows an old late cancellation separately while keeping a conflicting audited record", async () => {
    await academic.recordAttendance(admin, { ...target, outcome: "ABSENT" });
    await client.query("update class_reservations set status = 'CANCELLED' where id = $1", [target.reservationId]);
    await client.query(`
      insert into reservation_cancellations (id, reservation_id, class_session_id, student_profile_id,
        cancelled_at, cancellation_type, hours_before_start, meets_seven_day_rule, is_habitual_reservation)
      values ($1, $2, $3, $4, $5, 'LATE', 1, false, false)`,
    [randomUUID(), target.reservationId, target.classSessionId, profileId, endsAt]);
    expect((await academic.listStudentClassHistory(student, endsAt)).history)
      .toMatchObject([{ status: "CANCELLED", cancellationType: "LATE", attendanceOutcome: null }]);
    await expect(academic.correctAttendance(admin, { ...target, outcome: "PRESENT", reason: "Invalid legacy correction" }))
      .rejects.toMatchObject({ code: "reservation_not_confirmed" });
    expect(await attendance()).toMatchObject([{ outcome: "ABSENT", superseded_at: null }]);
  });

  it("keeps the existing absence detector within server time and independent of credits", async () => {
    vi.setSystemTime(new Date(endsAt.getTime() - 1));
    await expect(academic.detectAbsences(admin, { referenceTimeUtc: endsAt })).resolves.toMatchObject({ createdAbsences: 0 });
    vi.setSystemTime(endsAt);
    await expect(academic.detectAbsences(admin, {})).resolves.toEqual({ createdAbsences: 1, affectedProfiles: 1 });
    await expect(academic.detectAbsences(admin, {})).resolves.toEqual({ createdAbsences: 0, affectedProfiles: 0 });
    expect(await attendance()).toMatchObject([{ source: "AUTO", outcome: "ABSENT", recorded_at: endsAt }]);
    await expectNoCreditOrCancellation();
  });

  it("rechecks absence candidates if a cancellation commits while waiting for the session lock", async () => {
    await client.query("begin");
    await client.query("select id from class_sessions where id = $1 for update", [target.classSessionId]);
    const detection = academic.detectAbsences(admin, {});
    try {
      await vi.waitFor(async () => {
        await client.query("select pg_stat_clear_snapshot()");
        const { rows } = await client.query(`
          select pid from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock' and query like '%for no key update of s%'`);
        expect(rows).toHaveLength(1);
      }, { interval: 20, timeout: 2000 });
      await client.query("update class_reservations set status = 'CANCELLED' where id = $1", [target.reservationId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      await detection;
      throw error;
    }
    await expect(detection).resolves.toEqual({ createdAbsences: 0, affectedProfiles: 0 });
    expect(await attendance()).toEqual([]);
  });
});

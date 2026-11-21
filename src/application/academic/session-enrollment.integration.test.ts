import { randomUUID } from "node:crypto";
import { type Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

vi.mock("server-only", () => ({}));

describe.skipIf(!process.env.TEST_DATABASE_URL)("administrative enrollment in a single session", () => {
  let client: Client;
  let academic: typeof import("./academic-service");
  let calendar: typeof import("./admin-calendar-service");
  let first: Awaited<ReturnType<typeof seedStudent>>;
  let second: typeof first;
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" } as const;
  const otherAdmin = { userId: randomUUID(), role: "SUPER_ADMIN" } as const;
  const now = new Date("2031-04-01T15:00:00Z");
  const start = new Date("2031-04-10T15:00:00Z");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("./academic-service");
    calendar = await import("./admin-calendar-service");
  });

  beforeEach(async () => {
    vi.setSystemTime(now);
    await resetTestDatabase(client);
    await client.query(`insert into users (id, email, email_normalized, password_hash, role)
      values ($1, 'admin@example.com', 'admin@example.com', 'test', 'SUPER_ADMIN'),
             ($2, 'other-admin@example.com', 'other-admin@example.com', 'test', 'SUPER_ADMIN')`, [admin.userId, otherAdmin.userId]);
    first = await seedStudent("Ana", "Morales");
    second = await seedStudent("Eva", "Sorensen");
  });

  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await client?.end(); });

  async function seedStudent(firstName: string, lastName: string, status = "ACTIVE", role = "STUDENT") {
    const userId = randomUUID();
    const profileId = randomUUID();
    const email = `${userId}@example.com`;
    await client.query(`insert into users (id, email, email_normalized, password_hash, role, status, deactivated_at)
      values ($1, $2, $2, 'test', $3, $4::user_status, case when $4::user_status = 'DISABLED' then $5::timestamptz end)`,
    [userId, email, role, status, now]);
    await client.query("insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, $3, $4)",
      [profileId, userId, firstName, lastName]);
    return { userId, role: "STUDENT" as const, profileId, email };
  }

  async function seedSession(capacity = 1, status = "SCHEDULED", startsAt = start, templateId: string | null = null) {
    const id = randomUUID();
    await client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity, status, template_id)
      values ($1, $2, $3, $4, $5, $6, $7)`, [id, startsAt.toISOString().slice(0, 10), startsAt,
      new Date(startsAt.getTime() + 3_600_000), capacity, status, templateId]);
    return id;
  }

  function request(classSessionId: string, studentProfileId = first.profileId) {
    return { classSessionId, studentProfileId, reservationId: randomUUID() };
  }

  async function checkAvailability(id: string, confirmedReservations: number, blockedSpots: number, reservableSpots: number) {
    const detail = await calendar.getAdminCalendarSessionDetails(admin, id);
    const weekly = await calendar.listAdminCalendarSessions(admin, new Date("2031-04-01"), new Date("2031-04-13"), new Date());
    const capacity = { blockedSpots, confirmedReservations, reservableSpots };
    expect(detail?.capacityOverview).toMatchObject(capacity);
    expect(weekly.find((session) => session.id === id)).toMatchObject(capacity);
    return detail!;
  }

  async function race(operations: Promise<unknown>[], rejectedCodes: string[]) {
    const results = await Promise.allSettled(operations);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(rejectedCodes).toContain(loser?.reason.code);
    return results[0].status === "fulfilled";
  }

  it("persists an ordinary booking and its administrator and keeps existing bookings and credits intact", async () => {
    const id = await seedSession(3);
    const { reservationId: existingId } = await academic.createReservation(admin, {
      classSessionId: id, studentProfileId: second.profileId,
    });
    const input = request(id);
    await expect(academic.enrollStudentInSession(admin, input)).resolves.toEqual({
      reservationId: input.reservationId, created: true,
    });
    const { rows } = await client.query(`select * from class_reservations where id = $1`, [input.reservationId]);
    expect(rows).toMatchObject([{
      id: input.reservationId, class_session_id: id, student_profile_id: first.profileId, created_by_user_id: admin.userId,
      status: "CONFIRMED", origin: "ORDINARY", created_at: now, regulation_version_id: "initial",
    }]);
    const detail = await checkAvailability(id, 2, 0, 1);
    expect(detail.enrollments.map(({ reservationId }) => reservationId)).toEqual(expect.arrayContaining([existingId, input.reservationId]));
    expect((await client.query("select * from credit_ledger_movements")).rows).toEqual([]);
  });

  it("searches a bounded set of eligible profiles, handles homonyms and treats wildcard characters literally", async () => {
    const id = await seedSession();
    await seedStudent("Ana", "Desactivada", "DISABLED");
    await seedStudent("Ana", "Administradora", "ACTIVE", "SUPER_ADMIN");
    const homonym = await seedStudent("Ana", "Morales");
    const search = (query: string) => academic.searchSessionEnrollmentStudents(admin, { classSessionId: id, query });
    expect(await search("  aNA  ")).toEqual({ hasMore: false, students: expect.arrayContaining([
      { id: first.profileId, label: `Ana Morales (${first.email})` },
      { id: homonym.profileId, label: `Ana Morales (${homonym.email})` },
    ]) });
    expect((await search("Ana")).students).toHaveLength(2);
    expect((await search(first.email.toUpperCase())).students).toEqual([{ id: first.profileId, label: "Ana Morales" }]);
    expect((await search("Morales Ana")).students).toHaveLength(2);
    expect((await search("%%")).students).toEqual([]);
    for (let index = 0; index < 16; index++) await seedStudent("Lola", `Fixture ${index}`);
    expect(await search("Lo")).toMatchObject({ hasMore: true, students: expect.any(Array) });
    expect((await search("Lo")).students).toHaveLength(15);
    await academic.enrollStudentInSession(admin, request(id));
    expect((await search("Ana")).students).toEqual([{ id: homonym.profileId, label: "Ana Morales" }]);
  });

  it("rejects absent or disabled users, other roles, invalid UUIDs and non-administrators", async () => {
    const id = await seedSession();
    const disabled = await seedStudent("Baja", "Definitiva", "DISABLED");
    const nonStudent = await seedStudent("Otro", "Rol", "ACTIVE", "SUPER_ADMIN");
    for (const profileId of [randomUUID(), disabled.profileId, nonStudent.profileId]) {
      await expect(academic.enrollStudentInSession(admin, request(id, profileId))).rejects.toMatchObject({ code: "student_inactive" });
    }
    await expect(academic.enrollStudentInSession(first, request(id))).rejects.toMatchObject({ code: "forbidden" });
    await expect(academic.searchSessionEnrollmentStudents(first, { classSessionId: id, query: "Ana" })).rejects.toMatchObject({ code: "forbidden" });
    for (const key of ["classSessionId", "studentProfileId", "reservationId"]) {
      await expect(academic.enrollStudentInSession(admin, { ...request(id), [key]: "malformed" })).rejects.toMatchObject({ name: "ZodError" });
    }
    await expect(academic.enrollStudentInSession(admin, { ...request(id), origin: "MAKEUP" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(academic.enrollStudentInSession(admin, request(randomUUID()))).rejects.toMatchObject({ code: "session_not_found" });
    expect((await client.query("select id from class_reservations")).rows).toEqual([]);
  });

  it.each([
    ["CANCELLED", start], ["COMPLETED", start],
    ["SCHEDULED", now], ["SCHEDULED", new Date("2031-04-01T14:30Z")],
    ["SCHEDULED", new Date("2031-04-01T14:00Z")],
  ] as const)("rejects %s with start %s", async (status, startsAt) => {
    await expect(academic.enrollStudentInSession(admin, request(await seedSession(1, status, startsAt))))
      .rejects.toMatchObject({ code: "session_not_reservable" });
  });

  it("rejects a separate duplicate, replays once and requires a new request after cancellation", async () => {
    const id = await seedSession();
    const input = request(id);
    const results = await Promise.all(Array.from({ length: 3 }, () => academic.enrollStudentInSession(admin, input)));
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results.every(({ reservationId }) => reservationId === input.reservationId)).toBe(true);
    await expect(academic.enrollStudentInSession(admin, request(id))).rejects.toMatchObject({ code: "reservation_already_confirmed" });
    await expect(academic.enrollStudentInSession(otherAdmin, input)).rejects.toMatchObject({ code: "enrollment_id_conflict" });
    await expect(academic.enrollStudentInSession(admin, { ...input, studentProfileId: second.profileId }))
      .rejects.toMatchObject({ code: "enrollment_id_conflict" });
    await expect(academic.enrollStudentInSession(admin, { ...input, classSessionId: await seedSession() }))
      .rejects.toMatchObject({ code: "enrollment_id_conflict" });
    await academic.cancelReservation(first, { reservationId: input.reservationId });
    await expect(academic.enrollStudentInSession(admin, input)).rejects.toMatchObject({ code: "enrollment_already_cancelled" });
    const next = request(id);
    await expect(academic.enrollStudentInSession(admin, next)).resolves.toMatchObject({ created: true });
    const detail = await checkAvailability(id, 1, 0, 0);
    expect(detail.enrollments).toMatchObject([{ reservationId: next.reservationId }]);
    expect(detail.cancellations).toMatchObject([{ reservationId: input.reservationId }]);
    expect((await client.query("select id from credit_ledger_movements")).rows).toEqual([]);
  });

  it("respects a reduced effective capacity, blocks and existing reservations even above the new limit", async () => {
    const id = await seedSession(5);
    await academic.enrollStudentInSession(admin, request(id));
    await academic.addSessionCapacityBlock(admin, { classSessionId: id, blockId: randomUUID(), blockedSpots: 2, reason: "Evento" });
    const { publishAcademicRegulation } = await import("./regulation-service");
    await publishAcademicRegulation(admin, { ...INITIAL_REGULATION, effectiveFrom: "2031-04-02", maxClassCapacity: 2 });
    vi.setSystemTime(new Date("2031-04-02T15:00Z"));
    await expect(academic.enrollStudentInSession(admin, request(id, second.profileId))).rejects.toMatchObject({ code: "no_spots_available" });
    expect((await checkAvailability(id, 1, 2, 0)).capacityOverview)
      .toMatchObject({ physicalCapacity: 5, physicallyFreeSpots: 2, capacity: 2, capacityExcess: 1 });
  });

  it("serializes the last spot against another administrator and the existing ordinary flow", async () => {
    const id = await seedSession();
    await race([academic.enrollStudentInSession(admin, request(id)), academic.enrollStudentInSession(otherAdmin, request(id, second.profileId))],
      ["no_spots_available"]);
    await checkAvailability(id, 1, 0, 0);
    const other = await seedSession();
    await race([academic.enrollStudentInSession(admin, request(other)), academic.createReservationForCurrentStudent(second, other)],
      ["no_spots_available"]);
    await checkAvailability(other, 1, 0, 0);
  });

  it("serializes the last spot against a capacity block", async () => {
    const id = await seedSession();
    const enrolled = Number(await race([
      academic.enrollStudentInSession(admin, request(id)),
      academic.addSessionCapacityBlock(otherAdmin, { classSessionId: id, blockId: randomUUID(), blockedSpots: 1, reason: "Evento" }),
    ], ["no_spots_available", "capacity_conflict"]));
    await checkAvailability(id, enrolled, 1 - enrolled, 0);
  });

  it("checks the server clock after waiting for the session lock", async () => {
    const id = await seedSession();
    await client.query("begin");
    await client.query("select id from class_sessions where id = $1 for update", [id]);
    const waiting = Promise.allSettled([academic.enrollStudentInSession(admin, request(id))]);
    try {
      await vi.waitFor(async () => {
        await client.query("select pg_stat_clear_snapshot()");
        const { rows } = await client.query(`select pid from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and query like '%"class_sessions"%for update%'`);
        expect(rows).toHaveLength(1);
      }, { interval: 20, timeout: 2000 });
      vi.setSystemTime(start);
    } finally {
      await client.query("commit");
    }
    expect(await waiting).toMatchObject([{ status: "rejected", reason: { code: "session_not_reservable" } }]);
    expect((await client.query("select id from class_reservations")).rows).toEqual([]);
  });

  it("competes with recovery without consuming a credit for an ordinary booking or duplicating a makeup", async () => {
    const { reserveRecovery } = await import("@/src/application/recovery/recovery-service");
    const { grantManualCredits } = await import("@/src/application/credits/credit-service");
    await grantManualCredits(admin, { studentProfileId: second.profileId, amount: 2, reason: "Prueba de concurrencia" });
    const id = await seedSession();
    const enrolled = await race([
      academic.enrollStudentInSession(admin, request(id)),
      reserveRecovery(second, { classSessionId: id }),
    ], ["no_spots_available"]);
    const detail = await checkAvailability(id, 1, 0, 0);
    expect(detail.enrollments).toMatchObject([{ origin: enrolled ? "ORDINARY" : "MAKEUP" }]);
    expect((await client.query("select * from credit_ledger_movements where movement_type = 'RECOVERY_CONSUMPTION'")).rows)
      .toHaveLength(enrolled ? 0 : 1);
    const other = await seedSession(3);
    await reserveRecovery(second, { classSessionId: other });
    await expect(academic.enrollStudentInSession(admin, request(other, second.profileId)))
      .rejects.toMatchObject({ code: "reservation_already_confirmed" });
    expect((await checkAvailability(other, 1, 0, 2)).enrollments).toMatchObject([{ origin: "MAKEUP" }]);
  });

  it("keeps the documented pending-habitual rule without changing assignments or other dates", async () => {
    const templateId = randomUUID();
    await client.query(`insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
      values ($1, 'Curso habitual', 4, '17:00', 60, '2031-04-01')`, [templateId]);
    const assignmentId = randomUUID();
    await client.query(`insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
      values ($1, $2, $3, '2031-04-01')`, [assignmentId, first.profileId, templateId]);
    const id = await seedSession(1, "SCHEDULED", start, templateId);
    const later = await seedSession(1, "SCHEDULED", new Date("2031-04-17T15:00Z"), templateId);
    expect((await checkAvailability(id, 0, 0, 1)).capacityOverview).toMatchObject({ habitualPending: 1, capacityConflict: false });
    await academic.enrollStudentInSession(admin, request(id, second.profileId));
    expect((await checkAvailability(id, 1, 0, 0)).capacityOverview).toMatchObject({ habitualPending: 1, capacityConflict: true });
    await expect(academic.enrollStudentInSession(admin, request(id))).rejects.toMatchObject({ code: "no_spots_available" });
    expect((await calendar.getAdminCalendarSessionDetails(admin, later))?.enrollments).toEqual([]);
    expect((await client.query("select id from student_template_assignments")).rows).toEqual([{ id: assignmentId }]);
    await academic.enrollStudentInSession(admin, request(later));
    expect((await calendar.getAdminCalendarSessionDetails(admin, later))?.capacityOverview)
      .toMatchObject({ habitualPending: 0, confirmedReservations: 1, reservableSpots: 0 });
  });
});

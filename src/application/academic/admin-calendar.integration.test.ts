import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("admin calendar attendance (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academic: typeof import("./academic-service");
  let calendar: typeof import("./admin-calendar-service");
  const now = new Date("2031-01-07T17:00:00Z");
  const tomorrow = new Date("2031-01-08T17:00:00Z");
  const admin = { role: "SUPER_ADMIN", userId: randomUUID() } as const;

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("./academic-service");
    calendar = await import("./admin-calendar-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    vi.setSystemTime(now);
    await client.query(`insert into users (id, email, email_normalized, password_hash, role)
      values ($1, 'admin@example.com', 'admin@example.com', 'hash', 'SUPER_ADMIN')`, [admin.userId]);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await client?.end(); });

  it("joins only the current outcome to the correct reservation, keeping cancellations separate", async () => {
    const classSessionId = randomUUID();
    const otherSessionId = randomUUID();
    const [ordinary, makeup, cancelled, foreign] = Array.from({ length: 4 }, () => ({
      userId: randomUUID(), profileId: randomUUID(), reservationId: randomUUID(),
    }));
    const startsAt = new Date("2020-01-06T17:00:00.000Z");
    const endsAt = new Date("2020-01-06T18:00:00.000Z");
    await client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
      values ($1, '2020-01-06', $3, $4, 12), ($2, '2020-01-06', $3, $4, 12)`, [classSessionId, otherSessionId, startsAt, endsAt]);

    for (const [student, name] of [[ordinary, "Ana"], [makeup, "Bea"], [cancelled, "Carla"], [foreign, "Diana"]] as const) {
      await client.query(`insert into users (id, email, email_normalized, password_hash, role)
        values ($1, $2, $2, 'hash', 'STUDENT')`, [student.userId, `${name}@example.com`]);
      await client.query(`insert into student_profiles (id, user_id, first_name, last_name)
        values ($1, $2, $3, 'Prueba')`, [student.profileId, student.userId, name]);
      await client.query(`insert into class_reservations (id, class_session_id, student_profile_id, status, origin)
        values ($1, $2, $3, $4, $5)`, [student.reservationId, student === foreign ? otherSessionId : classSessionId,
        student.profileId, student === cancelled ? "CANCELLED" : "CONFIRMED", student === makeup ? "MAKEUP" : "ORDINARY"]);
    }

    const makeupTarget = { classSessionId, reservationId: makeup.reservationId };
    await academic.recordAttendance(admin, { ...makeupTarget, outcome: "PRESENT" });
    await academic.correctAttendance(admin, { ...makeupTarget, outcome: "ABSENT", reason: "Corrección de prueba" });
    await academic.recordAttendance(admin, { classSessionId: otherSessionId, reservationId: foreign.reservationId, outcome: "PRESENT" });
    await client.query(`insert into reservation_attendance_records
      (id, reservation_id, student_profile_id, class_session_id, outcome, source, recorded_at)
      values ($1, $2, $3, $4, 'ATTENDED', 'MANUAL', $5)`,
    [randomUUID(), cancelled.reservationId, cancelled.profileId, classSessionId, endsAt]);

    await expect(calendar.getAdminCalendarSessionDetails({ role: "STUDENT" }, classSessionId))
      .rejects.toMatchObject({ code: "forbidden" });
    const expectedReservations = {
      enrollments: [
        { reservationId: ordinary.reservationId, firstName: "Ana", origin: "ORDINARY", attendanceOutcome: null },
        { reservationId: makeup.reservationId, firstName: "Bea", origin: "MAKEUP", attendanceOutcome: "ABSENT" },
      ],
      cancellations: [{ reservationId: cancelled.reservationId, firstName: "Carla", attendanceOutcome: "ATTENDED" }],
    };
    const detail = await calendar.getAdminCalendarSessionDetails(admin, classSessionId);
    expect(detail).toMatchObject({ ...expectedReservations, sessionStatus: "SCHEDULED", startsAtUtc: startsAt, endsAtUtc: endsAt });
    await client.query("update class_sessions set status = 'CANCELLED' where id = $1", [classSessionId]);
    const cancelledDetail = await calendar.getAdminCalendarSessionDetails(admin, classSessionId);
    expect(cancelledDetail).toMatchObject({ ...expectedReservations, sessionStatus: "CANCELLED" });
  });

  async function seedSession({ capacity = 12, start = tomorrow, status = "SCHEDULED", templateId = null }: {
    capacity?: number; start?: Date; status?: string; templateId?: string | null;
  } = {}) {
    const id = randomUUID();
    const end = new Date(start.getTime() + 3_600_000);
    await client.query(`insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity, status)
      values ($1, $2, $3, $4, $5, $6, $7)`, [id, templateId, start.toISOString().slice(0, 10), start, end, capacity, status]);
    return id;
  }

  async function seedStudents(count: number) {
    const students = Array.from({ length: count }, () => ({ userId: randomUUID(), profileId: randomUUID(), role: "STUDENT" as const }));
    await client.query(`insert into users (id, email, email_normalized, password_hash, role)
      select id, id || '@example.com', id || '@example.com', 'hash', 'STUDENT' from unnest($1::text[]) as fixture(id)`,
    [students.map(({ userId }) => userId)]);
    await client.query(`insert into student_profiles (id, user_id, first_name, last_name)
      select profile_id, user_id, 'Test', 'Student' from unnest($1::text[], $2::text[]) as fixture(profile_id, user_id)`,
    [students.map(({ profileId }) => profileId), students.map(({ userId }) => userId)]);
    return students;
  }

  async function seedReservation(sessionId: string, profileId: string, origin: "ORDINARY" | "MAKEUP" = "ORDINARY") {
    const reservationId = randomUUID();
    await client.query(`insert into class_reservations (id, class_session_id, student_profile_id, origin) values ($1, $2, $3, $4)`,
      [reservationId, sessionId, profileId, origin]);
    return reservationId;
  }

  async function seedBlock(sessionId: string, spots: number, active: boolean) {
    await client.query(`insert into session_capacity_blocks (id, class_session_id, blocked_spots, is_active) values ($1, $2, $3, $4)`,
      [randomUUID(), sessionId, spots, active]);
  }

  type Capacity = NonNullable<Awaited<ReturnType<typeof calendar.getAdminCalendarSessionDetails>>>["capacityOverview"];

  async function expectCapacity(sessionId: string, expected: Partial<Capacity>, at = now) {
    const detail = await calendar.getAdminCalendarSessionDetails(admin, sessionId, at);
    expect(detail?.capacityOverview).toMatchObject(expected);
    const weekly = await calendar.listAdminCalendarSessions(admin, new Date("2031-01-05"), new Date("2031-01-12"), at);
    const { confirmedWithCancellation, ...capacity } = detail!.capacityOverview;
    expect(weekly.find((session) => session.id === sessionId)).toMatchObject(capacity);
    expect(capacity.confirmedReservations).toBe(detail!.enrollments.length + confirmedWithCancellation);
    return detail!;
  }

  it.each([
    { name: "empty", ordinary: 0, makeup: 0, blocked: 0, inactive: 0, free: 12, excess: 0 },
    { name: "partial with both reservation origins", ordinary: 3, makeup: 2, blocked: 0, inactive: 0, free: 7, excess: 0 },
    { name: "full with 12 reservations", ordinary: 12, makeup: 0, blocked: 0, inactive: 0, free: 0, excess: 0 },
    { name: "active and historical blocks", ordinary: 0, makeup: 0, blocked: 3, inactive: 2, free: 9, excess: 0 },
    { name: "confirmed reservations and blocks", ordinary: 4, makeup: 1, blocked: 2, inactive: 3, free: 5, excess: 0 },
    { name: "historical over-capacity data", ordinary: 11, makeup: 1, blocked: 2, inactive: 0, free: 0, excess: 2 },
  ])("counts capacity for a session that is $name", async ({ ordinary, makeup, blocked, inactive, free, excess }) => {
    const sessionId = await seedSession();
    const students = await seedStudents(ordinary + makeup);
    for (const [index, student] of students.entries()) {
      await seedReservation(sessionId, student.profileId, index < ordinary ? "ORDINARY" : "MAKEUP");
    }
    if (blocked > 0) await seedBlock(sessionId, blocked, true);
    if (inactive > 0) await seedBlock(sessionId, inactive, false);

    await expectCapacity(sessionId, {
      physicalCapacity: 12, capacity: 12, confirmedReservations: ordinary + makeup, blockedSpots: blocked,
      physicallyFreeSpots: free, reservableSpots: free, bookingStatus: "UPCOMING", capacityExcess: excess,
      habitualPending: null,
    });
  });

  it("counts a voluntary cancellation as free only until a replacement reservation confirms", async () => {
    const sessionId = await seedSession({ capacity: 1 });
    const [student, replacement] = await seedStudents(2);
    const reservationId = await seedReservation(sessionId, student.profileId);
    await expectCapacity(sessionId, { confirmedReservations: 1, physicallyFreeSpots: 0, reservableSpots: 0 });

    await academic.cancelReservation(student, { reservationId });
    await expectCapacity(sessionId, { confirmedReservations: 0, physicallyFreeSpots: 1, reservableSpots: 1 });

    await academic.createReservation(admin, { classSessionId: sessionId, studentProfileId: replacement.profileId, origin: "ORDINARY" });
    const detail = await expectCapacity(sessionId, { confirmedReservations: 1, physicallyFreeSpots: 0, reservableSpots: 0 });
    expect(detail.cancellations).toMatchObject([{ reservationId }]);
    expect(detail.enrollments).toHaveLength(1);
  });

  it("applies the effective limit used for student recoveries and reports capacity excess after a reduction", async () => {
    const { publishAcademicRegulation } = await import("./regulation-service");
    const { listFutureRecoveryOptions } = await import("@/src/application/recovery/recovery-service");
    const sessionId = await seedSession({ capacity: 4, start: new Date("2031-01-09T17:00:00Z") });
    const [student, occupant] = await seedStudents(2);
    await seedReservation(sessionId, occupant.profileId);
    await publishAcademicRegulation(admin, { ...INITIAL_REGULATION, effectiveFrom: "2031-01-08", maxClassCapacity: 2 });
    await expectCapacity(sessionId, { capacity: 4, physicallyFreeSpots: 3, reservableSpots: 3 });

    vi.setSystemTime(tomorrow);
    await expectCapacity(sessionId, { capacity: 2, physicalCapacity: 4, physicallyFreeSpots: 3, reservableSpots: 1 }, tomorrow);
    expect((await listFutureRecoveryOptions(student)).sessions).toMatchObject([{ id: sessionId, availableSpots: 1 }]);

    await seedBlock(sessionId, 2, true);
    await expectCapacity(sessionId, { capacityExcess: 1, physicallyFreeSpots: 1, reservableSpots: 0 }, tomorrow);
    expect((await listFutureRecoveryOptions(student)).sessions).toEqual([]);
  });

  it.each([
    { status: "SCHEDULED", start: now, bookingStatus: "IN_PROGRESS" },
    { status: "SCHEDULED", start: new Date("2031-01-07T16:00:00Z"), bookingStatus: "COMPLETED" },
    { status: "COMPLETED", start: new Date("2031-01-06T16:00:00Z"), bookingStatus: "COMPLETED" },
    { status: "CANCELLED", start: tomorrow, bookingStatus: "CANCELLED" },
  ] as const)("keeps historical counts and closes bookings in $bookingStatus ($status)", async ({ status, start, bookingStatus }) => {
    const sessionId = await seedSession({ start, status });
    const [student] = await seedStudents(1);
    await seedReservation(sessionId, student.profileId);
    await seedBlock(sessionId, 1, true);
    await expectCapacity(sessionId, { bookingStatus, confirmedReservations: 1, blockedSpots: 1, physicallyFreeSpots: 10, reservableSpots: 0 });
  });

  it("warns about pending habitual places without treating them as reservations", async () => {
    const templateId = randomUUID();
    await client.query(`insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
      values ($1, 'Habitual', 3, '18:00', 60, '2031-01-01')`, [templateId]);
    const sessionId = await seedSession({ capacity: 2, templateId });
    const [first, second, cancelled, confirmed] = await seedStudents(4);
    for (const student of [first, second, cancelled]) {
      await client.query(`insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
        values ($1, $2, $3, '2031-01-01')`, [randomUUID(), student.profileId, templateId]);
    }
    const reservationId = await seedReservation(sessionId, cancelled.profileId);
    await academic.cancelReservation(cancelled, { reservationId });
    await seedReservation(sessionId, confirmed.profileId, "MAKEUP");
    await expectCapacity(sessionId, { confirmedReservations: 1, reservableSpots: 1, habitualPending: 2, capacityConflict: true });
  });

  it("protects capacity, validates the session ID and flags a contradictory legacy cancellation", async () => {
    const sessionId = await seedSession();
    const [student] = await seedStudents(1);
    const reservationId = await seedReservation(sessionId, student.profileId);
    await client.query(`insert into reservation_cancellations
      (id, reservation_id, student_profile_id, class_session_id, cancelled_at, cancellation_type,
       hours_before_start, meets_seven_day_rule, is_habitual_reservation)
      values ($1, $2, $3, $4, $5, 'LATE', 24, false, false)`, [randomUUID(), reservationId, student.profileId, sessionId, now]);

    await expect(calendar.getAdminCalendarSessionDetails(student, sessionId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(calendar.getAdminCalendarSessionDetails(admin, "invalid")).resolves.toBeNull();
    await expect(calendar.getAdminCalendarSessionDetails(admin, randomUUID())).resolves.toBeNull();
    const detail = await expectCapacity(sessionId, { confirmedReservations: 1, confirmedWithCancellation: 1, reservableSpots: 11 });
    expect(detail.enrollments).toHaveLength(0);
    expect(detail.cancellations).toMatchObject([{ reservationId }]);
  });
});

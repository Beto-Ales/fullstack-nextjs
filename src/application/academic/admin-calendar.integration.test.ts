import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("admin calendar attendance (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academic: typeof import("./academic-service");
  let calendar: typeof import("./admin-calendar-service");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("./academic-service");
    calendar = await import("./admin-calendar-service");
    await resetTestDatabase(client);
  });

  afterAll(async () => { await client?.end(); });

  it("joins only the current outcome to the correct reservation, keeping cancellations separate", async () => {
    const admin = { role: "SUPER_ADMIN", userId: randomUUID() } as const;
    const classSessionId = randomUUID();
    const otherSessionId = randomUUID();
    const [ordinary, makeup, cancelled, foreign] = Array.from({ length: 4 }, () => ({
      userId: randomUUID(), profileId: randomUUID(), reservationId: randomUUID(),
    }));
    const startsAt = new Date("2020-01-06T17:00:00.000Z");
    const endsAt = new Date("2020-01-06T18:00:00.000Z");
    await client.query(`insert into users (id, email, email_normalized, password_hash, role)
      values ($1, 'admin@example.com', 'admin@example.com', 'hash', 'SUPER_ADMIN')`, [admin.userId]);
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
});

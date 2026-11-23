import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe("habitual reservation provenance (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let service: typeof import("@/src/application/academic/academic-service");
  let admin: { userId: string; role: "SUPER_ADMIN" };
  let today: string;

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    service = await import("@/src/application/academic/academic-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    const userId = randomUUID();
    await client.query(
      "insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash','SUPER_ADMIN')",
      [userId, `${userId}@example.com`],
    );
    admin = { userId, role: "SUPER_ADMIN" };
    today = DateTime.now().setZone(CENTER_TIME_ZONE).toISODate()!;
  });

  afterAll(async () => {
    await client?.end();
  });

  async function createStudent() {
    const userId = randomUUID();
    const profileId = randomUUID();
    await client.query(
      "insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash','STUDENT')",
      [userId, `${userId}@example.com`],
    );
    await client.query(
      "insert into student_profiles (id,user_id,first_name,last_name) values ($1,$2,'Test','Student')",
      [profileId, userId],
    );
    return profileId;
  }

  async function createTemplate(daysAhead: number) {
    const { templateId } = await service.createClassTemplate(admin, {
      name: "Provenance template",
      isoWeekday: DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: daysAhead }).weekday,
      startsAtLocalTime: "18:00",
      durationMinutes: 60,
      effectiveFrom: today,
    });
    return templateId;
  }

  async function addSession(templateId: string | null, localDate: string) {
    const classSessionId = randomUUID();
    const startsAt = DateTime.fromISO(`${localDate}T18:00`, { zone: CENTER_TIME_ZONE });
    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited)
       values ($1, $2, $3, $4, $5, 'SCHEDULED', 8, false)`,
      [classSessionId, templateId, localDate, startsAt.toJSDate(), startsAt.plus({ minutes: 60 }).toJSDate()],
    );
    return classSessionId;
  }

  async function reservationsOf(classSessionId: string) {
    return (await client.query(
      `select id, student_profile_id, status, origin, habitual_assignment_id
       from class_reservations where class_session_id = $1 order by student_profile_id`,
      [classSessionId],
    )).rows;
  }

  it("records the assignment that created each automatic habitual reservation", async () => {
    const student = await createStudent();
    const templateId = await createTemplate(2);
    const classSessionId = await addSession(templateId, DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 2 }).toISODate()!);

    const assignment = await service.assignStudentToTemplate(admin, {
      templateId, studentProfileId: student, effectiveFrom: today,
    });

    expect(assignment.autoReservedReservationCount).toBe(1);
    expect(await reservationsOf(classSessionId)).toEqual([{
      id: expect.any(String),
      student_profile_id: student,
      status: "CONFIRMED",
      origin: "ORDINARY",
      habitual_assignment_id: assignment.assignmentId,
    }]);
  });

  it("keeps provenance untouched when the habitual reservation is cancelled", async () => {
    const student = await createStudent();
    const templateId = await createTemplate(2);
    const classSessionId = await addSession(templateId, DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 2 }).toISODate()!);
    const { assignmentId } = await service.assignStudentToTemplate(admin, {
      templateId, studentProfileId: student, effectiveFrom: today,
    });
    const [reservation] = await reservationsOf(classSessionId);

    await service.cancelSessionEnrollment(admin, {
      classSessionId,
      reservationId: reservation.id,
      cancellationId: randomUUID(),
      reason: "Anulación administrativa de prueba",
    });

    expect(await reservationsOf(classSessionId)).toEqual([{
      id: reservation.id,
      student_profile_id: student,
      status: "CANCELLED",
      origin: "ORDINARY",
      habitual_assignment_id: assignmentId,
    }]);
  });

  it("leaves administrative enrollments without provenance", async () => {
    const student = await createStudent();
    const classSessionId = await addSession(null, DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 3 }).toISODate()!);

    await service.enrollStudentInSession(admin, {
      classSessionId, studentProfileId: student, reservationId: randomUUID(),
    });

    expect(await reservationsOf(classSessionId)).toEqual([{
      id: expect.any(String),
      student_profile_id: student,
      status: "CONFIRMED",
      origin: "ORDINARY",
      habitual_assignment_id: null,
    }]);
  });

  it("leaves generated reservations unreferenced when overlapping assignments make the origin ambiguous", async () => {
    const student = await createStudent();
    const templateId = await createTemplate(7);
    await client.query(
      `insert into student_template_assignments (id, student_profile_id, template_id, effective_from, effective_to, status)
       values ($1, $2, $3, $4, null, 'ACTIVE'), ($5, $2, $3, $4, $6, 'ACTIVE')`,
      [
        randomUUID(), student, templateId, today, randomUUID(),
        DateTime.fromISO(today, { zone: CENTER_TIME_ZONE }).plus({ months: 2 }).toISODate(),
      ],
    );

    const generated = await service.generateClassSessions(admin, { horizonMonths: 2 });
    const booked = (await client.query(
      `select r.habitual_assignment_id from class_reservations r
       join class_sessions s on s.id = r.class_session_id
       where s.template_id = $1`,
      [templateId],
    )).rows;

    expect(generated.habitualReservations).toBeGreaterThan(0);
    expect(booked).toHaveLength(generated.habitualReservations);
    expect(booked.every((row) => row.habitual_assignment_id === null)).toBe(true);
  });

  it("clears the reference instead of deleting the reservation if the assignment row disappears", async () => {
    const student = await createStudent();
    const templateId = await createTemplate(2);
    const classSessionId = await addSession(templateId, DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 2 }).toISODate()!);
    const { assignmentId } = await service.assignStudentToTemplate(admin, {
      templateId, studentProfileId: student, effectiveFrom: today,
    });

    await client.query("delete from student_template_assignments where id = $1", [assignmentId]);

    expect(await reservationsOf(classSessionId)).toEqual([expect.objectContaining({
      student_profile_id: student,
      status: "CONFIRMED",
      habitual_assignment_id: null,
    })]);
  });
});

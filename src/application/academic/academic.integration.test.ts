import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("academic integration (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academicService: typeof import("@/src/application/academic/academic-service");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academicService = await import("@/src/application/academic/academic-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    await client.query("begin");
  });

  afterEach(async () => {
    await client.query("rollback");
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  async function seedTemplateAndSession(localDate: string, startsAtUtcIso: string, endsAtUtcIso: string) {
    const templateId = randomUUID();
    const sessionId = randomUUID();

    await client.query(
      `insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, status, effective_from, max_capacity, created_at, updated_at)
       values
        ($1, 'Template', 2, '18:00:00', 60, 'ACTIVE', '2026-01-01', 12, now(), now())`,
      [templateId],
    );

    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited, created_at, updated_at)
       values
        ($1, $2, $3, $4, $5, 'SCHEDULED', 12, false, now(), now())`,
      [sessionId, templateId, localDate, startsAtUtcIso, endsAtUtcIso],
    );

    return { templateId, sessionId };
  }

  it("enforces single student profile per student user", async () => {
    const userId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [userId, `${userId}@example.com`, `${userId}@example.com`],
    );

    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Test', 'Student', now(), now())`,
      [randomUUID(), userId],
    );

    await expect(
      client.query(
        `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
         values ($1, $2, 'Test2', 'Student2', now(), now())`,
        [randomUUID(), userId],
      ),
    ).rejects.toBeDefined();

  });

  it("prevents duplicate active reservation for same student and session", async () => {
    const studentUserId = randomUUID();
    const templateId = randomUUID();
    const sessionId = randomUUID();
    const profileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );

    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'A', 'B', now(), now())`,
      [profileId, studentUserId],
    );

    await client.query(
      `insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, status, effective_from, max_capacity, created_at, updated_at)
       values
        ($1, 'Test class', 2, '18:00:00', 60, 'ACTIVE', '2026-01-01', 12, now(), now())`,
      [templateId],
    );

    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited, created_at, updated_at)
       values
        ($1, $2, '2026-01-06', '2026-01-06T17:00:00Z', '2026-01-06T18:00:00Z', 'SCHEDULED', 12, false, now(), now())`,
      [sessionId, templateId],
    );

    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CONFIRMED', 'ORDINARY', now(), now())`,
      [randomUUID(), sessionId, profileId],
    );

    await expect(
      client.query(
        `insert into class_reservations
          (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
         values
          ($1, $2, $3, 'CONFIRMED', 'ORDINARY', now(), now())`,
        [randomUUID(), sessionId, profileId],
      ),
    ).rejects.toBeDefined();

  });

  it("detects absences without relying on database UUID extensions", async () => {
    const adminUserId = randomUUID();
    const studentUserId = randomUUID();
    const profileId = randomUUID();
    const templateId = randomUUID();
    const sessionId = randomUUID();
    const reservationId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values
       ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now()),
       ($4, $5, $6, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [
        adminUserId,
        `${adminUserId}@example.com`,
        `${adminUserId}@example.com`,
        studentUserId,
        `${studentUserId}@example.com`,
        `${studentUserId}@example.com`,
      ],
    );

    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Absent', 'Student', now(), now())`,
      [profileId, studentUserId],
    );

    await client.query(
      `insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, status, effective_from, max_capacity, created_at, updated_at)
       values
        ($1, 'Test class', 2, '18:00:00', 60, 'ACTIVE', '2026-01-01', 12, now(), now())`,
      [templateId],
    );

    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited, created_at, updated_at)
       values
        ($1, $2, '2026-01-06', '2026-01-06T17:00:00Z', '2026-01-06T18:00:00Z', 'COMPLETED', 12, false, now(), now())`,
      [sessionId, templateId],
    );

    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CONFIRMED', 'ORDINARY', now(), now())`,
      [reservationId, sessionId, profileId],
    );

    const result = await academicService.detectAbsences(
      { userId: adminUserId, role: "SUPER_ADMIN" },
      { referenceTimeUtc: new Date("2026-01-07T00:00:00.000Z") },
    );

    expect(result.createdAbsences).toBe(1);

    const rows = await client.query<{ id: string; source: string }>(
      `select id, source
       from reservation_attendance_records
       where reservation_id = $1`,
      [reservationId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.id).toHaveLength(36);
    expect(rows.rows[0]?.source).toBe("AUTO");
  });

  it("reprograms a session across months and updates local_date for monthly accounting", async () => {
    const adminUserId = randomUUID();
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values
       ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now()),
       ($4, $5, $6, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [
        adminUserId,
        `${adminUserId}@example.com`,
        `${adminUserId}@example.com`,
        studentUserId,
        `${studentUserId}@example.com`,
        `${studentUserId}@example.com`,
      ],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Reprogram', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    const originalDate = "2026-01-10";
    const movedDate = "2026-02-10";
    const session = await seedTemplateAndSession(originalDate, "2026-01-10T17:00:00.000Z", "2026-01-10T18:00:00.000Z");

    await client.query(
      `insert into class_reservations (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values ($1, $2, $3, 'CONFIRMED', 'MAKEUP', now(), now())`,
      [randomUUID(), session.sessionId, studentProfileId],
    );

    const movedStart = DateTime.fromISO(`${movedDate}T18:00:00`, { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();
    const movedEnd = DateTime.fromISO(`${movedDate}T19:00:00`, { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();

    await academicService.updateClassSession(
      { userId: adminUserId, role: "SUPER_ADMIN" },
      { classSessionId: session.sessionId, startsAtUtc: movedStart, endsAtUtc: movedEnd },
    );

    const moved = await client.query<{ local_date: string }>(`select local_date from class_sessions where id = $1`, [session.sessionId]);
    expect(moved.rows[0]?.local_date).toBe(movedDate);
  });

  it("rejects reprogramming that would exceed monthly recovery limit after month change", async () => {
    const adminUserId = randomUUID();
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values
       ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now()),
       ($4, $5, $6, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [
        adminUserId,
        `${adminUserId}@example.com`,
        `${adminUserId}@example.com`,
        studentUserId,
        `${studentUserId}@example.com`,
        `${studentUserId}@example.com`,
      ],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Limit', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    const movable = await seedTemplateAndSession("2026-01-10", "2026-01-10T17:00:00.000Z", "2026-01-10T18:00:00.000Z");
    const monthTargetA = await seedTemplateAndSession("2026-02-03", "2026-02-03T17:00:00.000Z", "2026-02-03T18:00:00.000Z");
    const monthTargetB = await seedTemplateAndSession("2026-02-17", "2026-02-17T17:00:00.000Z", "2026-02-17T18:00:00.000Z");

    await client.query(
      `insert into class_reservations (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
       ($1, $2, $4, 'CONFIRMED', 'MAKEUP', now(), now()),
       ($3, $5, $4, 'CONFIRMED', 'MAKEUP', now(), now()),
       ($6, $7, $4, 'CONFIRMED', 'MAKEUP', now(), now())`,
      [
        randomUUID(),
        movable.sessionId,
        randomUUID(),
        studentProfileId,
        monthTargetA.sessionId,
        randomUUID(),
        monthTargetB.sessionId,
      ],
    );

    const movedStart = DateTime.fromISO("2026-02-10T18:00:00", { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();
    const movedEnd = DateTime.fromISO("2026-02-10T19:00:00", { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();

    await expect(
      academicService.updateClassSession(
        { userId: adminUserId, role: "SUPER_ADMIN" },
        { classSessionId: movable.sessionId, startsAtUtc: movedStart, endsAtUtc: movedEnd },
      ),
    ).rejects.toMatchObject({ code: "reprogram_monthly_recovery_limit_conflict" });
  });
});

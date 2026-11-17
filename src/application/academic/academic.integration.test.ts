import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(Boolean(testDatabaseUrl))("academic integration (postgres)", () => {
  const client = new Client({ connectionString: testDatabaseUrl });

  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    await client.query("begin");
  });

  afterEach(async () => {
    await client.query("rollback");
  });

  afterAll(async () => {
    await client.end();
  });

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
});

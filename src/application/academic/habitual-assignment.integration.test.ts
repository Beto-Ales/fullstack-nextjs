import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("habitual assignment integration (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academicService: typeof import("@/src/application/academic/academic-service");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academicService = await import("@/src/application/academic/academic-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  it("requires SUPER_ADMIN to assign a student to template", async () => {
    await expect(
      academicService.assignStudentToTemplate(
        { userId: randomUUID(), role: "STUDENT" },
        {
          studentProfileId: randomUUID(),
          templateId: randomUUID(),
          effectiveFrom: "2099-01-01",
        },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("creates habitual reservations for future sessions without duplicates and respecting capacity", async () => {
    const adminUserId = randomUUID();
    const targetStudentUserId = randomUUID();
    const occupiedStudentUserId = randomUUID();
    const targetProfileId = randomUUID();
    const occupiedProfileId = randomUUID();
    const templateId = randomUUID();
    const anotherTemplateId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values
       ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now()),
       ($4, $5, $6, 'hash', 'STUDENT', 'ACTIVE', now(), now()),
       ($7, $8, $9, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [
        adminUserId,
        `${adminUserId}@example.com`,
        `${adminUserId}@example.com`,
        targetStudentUserId,
        `${targetStudentUserId}@example.com`,
        `${targetStudentUserId}@example.com`,
        occupiedStudentUserId,
        `${occupiedStudentUserId}@example.com`,
        `${occupiedStudentUserId}@example.com`,
      ],
    );

    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values
       ($1, $2, 'Target', 'Student', now(), now()),
       ($3, $4, 'Occupied', 'Student', now(), now())`,
      [targetProfileId, targetStudentUserId, occupiedProfileId, occupiedStudentUserId],
    );

    await client.query(
      `insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, status, effective_from, max_capacity, created_at, updated_at)
       values
        ($1, 'Habitual Template', 2, '18:00:00', 60, 'ACTIVE', '2098-01-01', 2, now(), now()),
        ($2, 'Another Template', 4, '18:00:00', 60, 'ACTIVE', '2098-01-01', 2, now(), now())`,
      [templateId, anotherTemplateId],
    );

    const availableSessionId = randomUUID();
    const fullSessionId = randomUUID();
    const alreadyReservedSessionId = randomUUID();
    const otherTemplateSessionId = randomUUID();
    const pastSessionId = randomUUID();

    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity, is_manually_edited, created_at, updated_at)
       values
        ($1, $6, '2099-01-06', '2099-01-06T17:00:00.000Z', '2099-01-06T18:00:00.000Z', 'SCHEDULED', 2, false, now(), now()),
        ($2, $6, '2099-01-13', '2099-01-13T17:00:00.000Z', '2099-01-13T18:00:00.000Z', 'SCHEDULED', 1, false, now(), now()),
        ($3, $6, '2099-01-20', '2099-01-20T17:00:00.000Z', '2099-01-20T18:00:00.000Z', 'SCHEDULED', 2, false, now(), now()),
        ($4, $7, '2099-01-27', '2099-01-27T17:00:00.000Z', '2099-01-27T18:00:00.000Z', 'SCHEDULED', 2, false, now(), now()),
        ($5, $6, '2000-01-04', '2000-01-04T17:00:00.000Z', '2000-01-04T18:00:00.000Z', 'SCHEDULED', 2, false, now(), now())`,
      [availableSessionId, fullSessionId, alreadyReservedSessionId, otherTemplateSessionId, pastSessionId, templateId, anotherTemplateId],
    );

    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CONFIRMED', 'ORDINARY', now(), now()),
        ($4, $5, $6, 'CONFIRMED', 'ORDINARY', now(), now())`,
      [randomUUID(), fullSessionId, occupiedProfileId, randomUUID(), alreadyReservedSessionId, targetProfileId],
    );

    const result = await academicService.assignStudentToTemplate(
      { userId: adminUserId, role: "SUPER_ADMIN" },
      {
        studentProfileId: targetProfileId,
        templateId,
        effectiveFrom: "2099-01-01",
      },
    );

    expect(result.autoReservedReservationCount).toBe(1);

    const targetReservations = await client.query<{ class_session_id: string }>(
      `select class_session_id
       from class_reservations
       where student_profile_id = $1
         and status = 'CONFIRMED'
       order by class_session_id`,
      [targetProfileId],
    );

    const reservedSessionIds = targetReservations.rows.map((row) => row.class_session_id);
    expect(reservedSessionIds).toContain(availableSessionId);
    expect(reservedSessionIds).toContain(alreadyReservedSessionId);
    expect(reservedSessionIds).not.toContain(fullSessionId);
    expect(reservedSessionIds).not.toContain(otherTemplateSessionId);
    expect(reservedSessionIds).not.toContain(pastSessionId);

    const duplicateCheck = await client.query<{ count: string }>(
      `select count(*)::text as count
       from class_reservations
       where class_session_id = $1
         and student_profile_id = $2
         and status = 'CONFIRMED'`,
      [alreadyReservedSessionId, targetProfileId],
    );
    expect(Number(duplicateCheck.rows[0]?.count ?? "0")).toBe(1);
  });
});

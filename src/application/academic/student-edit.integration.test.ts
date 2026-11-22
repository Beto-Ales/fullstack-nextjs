import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "@/src/infrastructure/security/password";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("audited student details edit (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let update: typeof import("./student-edit-service").updateStudentDetails;
  let auth: typeof import("../auth/auth-service");
  let repository: typeof import("@/src/infrastructure/auth/auth-repository");
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" } as const;
  const otherAdmin = { userId: randomUUID(), role: "SUPER_ADMIN" } as const;
  const student = { userId: randomUUID(), role: "STUDENT" } as const;
  const otherStudentId = randomUUID();
  const id = randomUUID();
  const otherId = randomUUID();
  const password = "synthetic-test-password";
  let hash: string;
  let version: string;
  const initial = { firstName: "Ana", lastName: "Vilá", email: "ana@example.com", contactEmail: "", contactPhone: "" };

  async function getVersion(profileId = id) {
    const { rows: [row] } = await client.query<{ version: string }>(
      "select extract(epoch from updated_at)::text as version from student_profiles where id = $1", [profileId],
    );
    return row.version;
  }

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    ({ updateStudentDetails: update } = await import("./student-edit-service"));
    auth = await import("../auth/auth-service");
    repository = await import("@/src/infrastructure/auth/auth-repository");
    hash = await hashPassword(password);
  });
  beforeEach(async () => {
    await resetTestDatabase(client);
    await client.query(`insert into users (id, email, email_normalized, password_hash, role)
      values ($1, 'admin@example.com', 'admin@example.com', $5, 'SUPER_ADMIN'),
      ($2, 'other-admin@example.com', 'other-admin@example.com', $5, 'SUPER_ADMIN'),
      ($3, 'ana@example.com', 'ana@example.com', $5, 'STUDENT'),
      ($4, 'occupied@example.com', 'occupied@example.com', $5, 'STUDENT')`,
    [admin.userId, otherAdmin.userId, student.userId, otherStudentId, hash]);
    await client.query(`insert into student_profiles (id, user_id, first_name, last_name)
      values ($1, $2, 'Ana', 'Vilá'), ($3, $4, 'Otra', 'Alumna')`, [id, student.userId, otherId, otherStudentId]);
    version = await getVersion();
  });
  afterAll(async () => { await client?.end(); });

  function request(data = initial, expected = version, studentProfileId: string = id) {
    return { studentProfileId, version: expected, data };
  }

  it("changes normalized details, preserves account and academic records, and audits exactly the changed fields", async () => {
    const sessionId = randomUUID();
    const reservationId = randomUUID();
    const ledgerId = randomUUID();
    await client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
      values ($1, '2020-01-15', '2020-01-15 15:00Z', '2020-01-15 16:00Z', 12)`, [sessionId]);
    await client.query(`insert into class_reservations (id, class_session_id, student_profile_id) values ($1, $2, $3)`,
    [reservationId, sessionId, id]);
    await client.query(`insert into reservation_attendance_records
      (id, reservation_id, class_session_id, student_profile_id, outcome, source, recorded_at)
      values ($1, $2, $3, $4, 'ATTENDED', 'MANUAL', '2020-01-15 16:30Z')`, [randomUUID(), reservationId, sessionId, id]);
    await client.query(`insert into credit_ledger_movements (id, student_profile_id, movement_type, amount, idempotency_key)
      values ($1, $2, 'MANUAL_GRANT', 1, $1)`, [ledgerId, id]);
    const tables = ["class_reservations", "reservation_attendance_records", "credit_ledger_movements"];
    const before = [];
    for (const table of tables) before.push((await client.query(`select * from ${table}`)).rows);
    const form = request({
      firstName: "  Ana   María ", lastName: " Vilá Torres ", email: " NUEVO@Example.COM ",
      contactEmail: " CONTACTO@EXAMPLE.COM ", contactPhone: " +45 (12) 34-56 78 ",
    });
    await expect(update(admin, form)).resolves.toEqual({ updated: true });
    const { rows: [user] } = await client.query("select * from users where id = $1", [student.userId]);
    expect(user).toMatchObject({ id: student.userId, role: "STUDENT", password_hash: hash,
      email: "nuevo@example.com", email_normalized: "nuevo@example.com" });
    const { rows: [profile] } = await client.query("select * from student_profiles where id = $1", [id]);
    expect(profile).toMatchObject({ id, user_id: student.userId, first_name: "Ana María", last_name: "Vilá Torres",
      contact_email: "contacto@example.com", contact_phone: "+4512345678" });
    const { rows: [audit] } = await client.query("select * from student_profile_edits");
    expect(audit).toMatchObject({ student_profile_id: id, edited_by_user_id: admin.userId, edited_at: expect.any(Date),
      operation: "UPDATE_STUDENT_DETAILS", changes: {
        firstName: { before: "Ana", after: "Ana María" }, lastName: { before: "Vilá", after: "Vilá Torres" },
        email: { before: "ana@example.com", after: "nuevo@example.com" },
        contactEmail: { before: null, after: "contacto@example.com" }, contactPhone: { before: null, after: "+4512345678" },
      } });
    await expect(update(admin, form)).resolves.toEqual({ updated: false });
    expect((await client.query("select * from student_profile_edits")).rows).toEqual([audit]);
    for (const [index, table] of tables.entries()) expect((await client.query(`select * from ${table}`)).rows).toEqual(before[index]);
    await update(admin, request({ ...form.data, contactEmail: "", contactPhone: " " }, await getVersion()));
    expect((await client.query("select contact_email, contact_phone from student_profiles where id = $1", [id])).rows[0])
      .toEqual({ contact_email: null, contact_phone: null });
  });

  it("rejects invalid input, extra fields, missing students and unauthorized accounts", async () => {
    await expect(update(student, request())).rejects.toMatchObject({ code: "forbidden" });
    await expect(update({ ...admin, userId: student.userId }, request())).rejects.toMatchObject({ code: "forbidden" });
    await expect(update(admin, request(initial, version, randomUUID()))).rejects.toMatchObject({ code: "student_not_found" });
    await expect(update(admin, request(initial, version, "invalid"))).rejects.toHaveProperty("issues");
    for (const data of [
      { ...initial, role: "SUPER_ADMIN" }, { ...initial, status: "DISABLED" }, { ...initial, email: "invalid" },
      { ...initial, firstName: "  " }, { ...initial, lastName: "a".repeat(121) },
      { ...initial, contactPhone: "123 ABC" }, { ...initial, contactEmail: "missing-domain" },
    ]) await expect(update(admin, request(data))).rejects.toHaveProperty("issues");
    expect((await client.query("select id from student_profile_edits")).rowCount).toBe(0);
  });

  it("rechecks the student status under lock when a concurrent deactivation wins", async () => {
    await client.query("begin");
    try {
      await client.query("update users set status = 'DISABLED' where id = $1", [student.userId]);
      const edit = update(admin, request({ ...initial, firstName: "Otro" }));
      const checked = expect(edit).rejects.toMatchObject({ code: "student_disabled" });
      await client.query("commit");
      await checked;
    } finally {
      await client.query("rollback");
    }
    expect((await client.query("select id from student_profile_edits")).rowCount).toBe(0);
  });

  it("keeps one audit for concurrent edits and rejects stale versions even after values are restored", async () => {
    const result = await Promise.allSettled([
      update(admin, request({ ...initial, firstName: "Primera" })),
      update(otherAdmin, request({ ...initial, firstName: "Segunda" })),
    ]);
    expect(result.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(result.find(({ status }) => status === "rejected")).toMatchObject({ reason: { code: "student_edit_conflict" } });
    const audit = await client.query("select edited_by_user_id from student_profile_edits");
    expect(audit.rows).toEqual([{ edited_by_user_id: result[0].status === "fulfilled" ? admin.userId : otherAdmin.userId }]);
    await update(admin, request(initial, await getVersion()));
    await expect(update(admin, request({ ...initial, firstName: "Antigua" })))
      .rejects.toMatchObject({ code: "student_edit_conflict" });
  });

  it("uses PostgreSQL uniqueness for case-normalized duplicates and concurrent email changes", async () => {
    await expect(update(admin, request({ ...initial, email: " OCCUPIED@Example.com " })))
      .rejects.toMatchObject({ code: "student_email_duplicate" });
    expect(await getVersion()).toBe(version);
    const result = await Promise.allSettled([
      update(admin, request({ ...initial, email: "SAME@example.com" })),
      update(otherAdmin, request({ ...initial, firstName: "Otra", lastName: "Alumna", email: "same@EXAMPLE.com" },
        await getVersion(otherId), otherId)),
    ]);
    expect(result.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(result.find(({ status }) => status === "rejected")).toMatchObject({ reason: { code: "student_email_duplicate" } });
    expect((await client.query("select id from student_profile_edits")).rowCount).toBe(1);
  });

  it("rolls back personal data and email when the audit insert fails", async () => {
    await client.query("alter table student_profile_edits add constraint reject_edit_fixture check (false)");
    try {
      await expect(update(admin, request({ ...initial, firstName: "Otro", email: "otra@example.com" }))).rejects.toThrow();
      expect(await getVersion()).toBe(version);
      const { rows: [row] } = await client.query("select p.first_name, u.email from student_profiles p join users u on u.id = p.user_id where p.id = $1", [id]);
      expect(row).toEqual({ first_name: "Ana", email: "ana@example.com" });
    } finally {
      await client.query("alter table student_profile_edits drop constraint reject_edit_fixture");
    }
  });

  it("uses the new login email and preserves existing sessions and credential-race protections", async () => {
    const credentials = { password, sourceKey: "student-edit-integration" };
    const existing = await auth.authenticateUser({ email: initial.email, ...credentials });
    await update(admin, request({ ...initial, email: "nuevo@example.com" }));
    await expect(auth.getAuthenticatedUserFromSessionToken(existing.sessionToken))
      .resolves.toMatchObject({ userId: student.userId, email: "nuevo@example.com" });
    await expect(auth.authenticateUser({ email: "NUEVO@example.com", ...credentials })).resolves.toMatchObject({ userId: student.userId });
    await expect(auth.authenticateUser({ email: initial.email, ...credentials })).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(repository.createSession({
      id: randomUUID(), userId: student.userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 600_000),
    }, hash, initial.email)).resolves.toBe(false);
  });
});

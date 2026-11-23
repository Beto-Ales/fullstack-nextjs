import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

const run = promisify(execFile);
const parsers = ["cli-date", "cli-iso"] as const;
type Generator = "application" | (typeof parsers)[number];

describe("session generation (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let service: typeof import("@/src/application/academic/academic-service");
  let admin: { userId: string; role: "SUPER_ADMIN" };
  let date: string;
  let now: DateTime;
  let templateId: string;
  let versionId: string;

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    service = await import("@/src/application/academic/academic-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    admin = { userId: await createUser("SUPER_ADMIN"), role: "SUPER_ADMIN" };
    now = DateTime.now().setZone(CENTER_TIME_ZONE);
    const classDate = now.plus({ days: 2 });
    date = classDate.toISODate()!;
    versionId = randomUUID();
    await client.query(
      `insert into academic_regulations
        (id, effective_from, cancellation_notice_days, monthly_cancellation_credits,
         monthly_recoveries, credit_expiration_months, max_class_capacity, changes)
        values ($1, $2, 7, 2, 2, 6, 2, '{}'::jsonb)`,
      [versionId, now.toISODate()],
    );
    templateId = randomUUID();
    await client.query(
      `insert into class_templates
        (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from, effective_to, max_capacity)
        values ($1, 'Recurring test session', $2, '18:00:00', 60, $3, $3, 12)`,
      [templateId, classDate.weekday, date],
    );
  });

  afterAll(async () => {
    await client?.end();
  });

  async function createUser(role: "STUDENT" | "SUPER_ADMIN") {
    const id = randomUUID();
    await client.query(
      "insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash',$3)",
      [id, `${id}@example.com`, role],
    );
    return id;
  }

  async function createStudent() {
    const studentUserId = await createUser("STUDENT");
    const profileId = randomUUID();
    await client.query(
      "insert into student_profiles (id,user_id,first_name,last_name) values ($1,$2,'Test','Student')",
      [profileId, studentUserId],
    );
    return profileId;
  }

  async function assign(studentProfileId: string, effectiveFrom = date, effectiveTo?: string) {
    return service.assignStudentToTemplate(admin, { templateId, studentProfileId, effectiveFrom, effectiveTo });
  }

  async function generate(generator: Generator) {
    if (generator === "application") {
      return service.generateClassSessions(admin, { horizonMonths: 1 });
    }
    const args = ["scripts/generate-class-sessions.mjs"];
    if (generator === "cli-iso") {
      const preload = `import { createRequire } from "node:module";
        const require = createRequire(process.cwd() + "/package.json");
        require("pg").types.setTypeParser(1082, (value) => value);`;
      args.unshift("--import", `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`);
    }
    return run(process.execPath, args, {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, TZ: "Pacific/Auckland" },
    });
  }

  async function sessions() {
    return (await client.query(
      `select id, local_date::text, starts_at_utc, max_capacity, regulation_version_id
       from class_sessions where template_id = $1`,
      [templateId],
    )).rows;
  }

  async function reservations(classSessionId: string) {
    return (await client.query(
      "select student_profile_id, origin, status, regulation_version_id from class_reservations where class_session_id = $1",
      [classSessionId],
    )).rows;
  }

  it.each(["application", ...parsers] as const)("preserves calendar dates and books current assignments once with %s", async (generator) => {
    const active = await createStudent();
    const bounded = await createStudent();
    const expired = await createStudent();
    const later = await createStudent();
    await assign(active);
    await assign(active, date, date);
    await assign(bounded, now.toISODate()!, date);
    await assign(expired, now.toISODate()!, now.plus({ days: 1 }).toISODate()!);
    await assign(later, now.plus({ days: 3 }).toISODate()!);

    await generate(generator);
    await generate(generator);

    const created = await sessions();
    expect(created).toEqual([expect.objectContaining({
      local_date: date,
      starts_at_utc: DateTime.fromISO(date + "T18:00", { zone: CENTER_TIME_ZONE }).toJSDate(),
      max_capacity: 2,
      regulation_version_id: versionId,
    })]);
    const booked = await reservations(created[0].id);
    expect(booked).toHaveLength(2);
    expect(booked).toEqual(expect.arrayContaining([active, bounded].map((id) => ({
      student_profile_id: id, origin: "ORDINARY", status: "CONFIRMED", regulation_version_id: versionId,
    }))));
  });

  it.each(["application", "cli-date"] as const)("reports an over-capacity group without selecting a subset with %s", async (generator) => {
    for (let index = 0; index < 3; index += 1) await assign(await createStudent());
    const outcome = await generate(generator);
    const [created] = await sessions();
    const retried = await generate(generator);
    for (const result of [outcome, retried]) {
      if ("stderr" in result) {
        expect(result.stderr).toContain(`Habitual capacity conflicts: ${created.id}`);
      } else {
        expect(result.habitualCapacityConflicts).toEqual([created.id]);
        expect(result.habitualReservations).toBe(0);
      }
    }

    expect(await sessions()).toHaveLength(1);
    expect(await reservations(created.id)).toHaveLength(0);
  });

  it.each(["application", "cli-date"] as const)("still reports a generated session with blocked seats on retry with %s", async (generator) => {
    await generate("application");
    const [created] = await sessions();
    await service.addSessionCapacityBlock(admin, { classSessionId: created.id, blockId: randomUUID(), blockedSpots: 2, reason: "Bloqueo de prueba" });
    expect(await assign(await createStudent())).toMatchObject({ autoReservedReservationCount: 0 });
    const retried = await generate(generator);
    if ("stderr" in retried) {
      expect(retried.stderr).toContain(`Habitual capacity conflicts: ${created.id}`);
    } else {
      expect(retried).toMatchObject({ inserted: 0, skipped: 1, habitualCapacityConflicts: [created.id] });
    }
    expect(await sessions()).toEqual([created]);
    expect(await reservations(created.id)).toHaveLength(0);
  });

  it("keeps one session and one booking when the CLI, application and assignment run concurrently", async () => {
    const student = await createStudent();
    await Promise.all([generate("application"), generate("cli-date"), assign(student)]);

    const created = await sessions();
    expect(created).toHaveLength(1);
    expect(await reservations(created[0].id)).toEqual([{
      student_profile_id: student, origin: "ORDINARY", status: "CONFIRMED", regulation_version_id: versionId,
    }]);
  });

  it("locks the later template before taking a profile reference for the first template", async () => {
    const student = await createStudent();
    await assign(student);
    const laterTemplate = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    await client.query(`insert into class_templates
      (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from, effective_to, max_capacity)
      select $1, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from, effective_to, max_capacity
      from class_templates where id = $2`, [laterTemplate, templateId]);
    const { assignmentId } = await service.assignStudentToTemplate(admin, {
      templateId: laterTemplate, studentProfileId: student, effectiveFrom: date,
    });

    const blocker = await createVerifiedTestClient();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(903000044, hashtext($1))", [laterTemplate]);
      const generation = generate("cli-date").then(() => null, (error: unknown) => error);
      try {
        const { rows: [owner] } = await blocker.query("select pg_backend_pid() as pid");
        await expect.poll(async () => {
          const { rowCount } = await client.query(`select 1 from pg_stat_activity
            where $1 = any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock%'`, [owner.pid]);
          return rowCount;
        }, { timeout: 5000 }).toBe(1);
        // This is the next lock an assignment ending on the later template would take.
        await blocker.query("set local lock_timeout = '3s'");
        await blocker.query("select id from student_profiles where id = $1 for update", [student]);
      } finally {
        await blocker.query("rollback");
        expect(await generation).toBeNull();
      }
      const [created] = await sessions();
      expect(await reservations(created.id)).toEqual([expect.objectContaining({ student_profile_id: student })]);

      await blocker.query("begin");
      const { rows: [{ pid }] } = await blocker.query("select pg_backend_pid() as pid");
      await blocker.query("select id from student_profiles where id = $1 for update", [student]);
      const ending = service.endStudentTemplateAssignment(admin, { assignmentId, effectiveTo: date })
        .then(() => null, (error: unknown) => error);
      let regeneration: Promise<unknown> | undefined;
      try {
        let endingPid: number;
        await expect.poll(async () => {
          const { rows } = await client.query(`select pid from pg_stat_activity
            where $1 = any(pg_blocking_pids(pid)) and query like '%from student_profiles%for update%'`, [pid]);
          endingPid = rows[0]?.pid;
          return rows.length;
        }).toBe(1);
        regeneration = generate("cli-date").then(() => null, (error: unknown) => error);
        await expect.poll(async () => (await client.query(`select pid from pg_stat_activity
          where $1 = any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock%'`, [endingPid])).rowCount).toBe(1);
      } finally {
        await blocker.query("rollback");
        expect(await ending).toBeNull();
        if (regeneration) expect(await regeneration).toBeNull();
      }

      await client.query("delete from class_sessions where template_id in ($1, $2)", [templateId, laterTemplate]);
      await client.query(`alter table class_sessions add constraint h09_generation_failure
        check (template_id <> 'ffffffff-ffff-ffff-ffff-ffffffffffff') not valid`);
      try {
        await expect(generate("cli-date")).rejects.toThrow("Failed to generate class sessions");
        expect(await sessions()).toEqual([]);
        expect((await client.query("select id from class_sessions where template_id = $1", [laterTemplate])).rows).toEqual([]);
      } finally {
        await client.query("alter table class_sessions drop constraint h09_generation_failure");
      }
    } finally {
      await blocker.end();
    }
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

type Connection = Awaited<ReturnType<typeof createVerifiedTestClient>>;
type Entry = "generic" | "detail" | "recovery";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("H06 reservation admission (postgres)", () => {
  let client: Connection;
  let academic: typeof import("./academic-service");
  let recovery: typeof import("@/src/application/recovery/recovery-service");
  let credits: typeof import("@/src/application/credits/credit-service");
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };
  const student = { userId: randomUUID(), role: "STUDENT" as const };
  const studentProfileId = randomUUID();

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("./academic-service");
    recovery = await import("@/src/application/recovery/recovery-service");
    credits = await import("@/src/application/credits/credit-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    await client.query(`insert into users (id,email,email_normalized,password_hash,role)
      values ($1,'admin@example.com','admin@example.com','hash','SUPER_ADMIN'),
        ($2,'student@example.com','student@example.com','hash','STUDENT')`, [admin.userId, student.userId]);
    await client.query("insert into student_profiles (id,user_id,first_name,last_name) values ($1,$2,'Test','Student')",
      [studentProfileId, student.userId]);
  });

  afterAll(async () => { await client?.end(); });

  async function seedSession(offsetMilliseconds: number, status = "SCHEDULED") {
    const id = randomUUID();
    await client.query(`with timing as materialized (select clock_timestamp() + $2::int * interval '1 millisecond' as starts)
      insert into class_sessions (id,local_date,starts_at_utc,ends_at_utc,status,max_capacity)
      select $1,(starts at time zone 'Europe/Copenhagen')::date,starts,starts+interval '1 hour',$3::class_session_status,12 from timing`,
    [id, offsetMilliseconds, status]);
    return id;
  }

  function book(entry: Entry, classSessionId: string, id = randomUUID()): Promise<unknown> {
    if (entry === "generic") return academic.createReservation(admin, { classSessionId, studentProfileId });
    if (entry === "detail") return academic.enrollStudentInSession(admin, { classSessionId, studentProfileId, reservationId: id });
    return recovery.reserveRecovery(student, { classSessionId, idempotencyKey: id });
  }

  const grant = () => credits.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId, amount: 1, reason: "Saldo de prueba" });

  async function observeWait(pid: number) {
    let waiting: { pid: number; query: string } | undefined;
    await expect.poll(async () => {
      const { rows } = await client.query<{ pid: number; query: string }>(`select pid,query from pg_stat_activity
        where datname=current_database() and state='active' and $1=any(pg_blocking_pids(pid))`, [pid]);
      waiting = rows[0];
      return rows.length;
    }, { interval: 25, timeout: 2_000 }).toBe(1);
    return waiting!;
  }

  async function withGate(run: (gate: {
    blocker: Connection;
    pid: number;
    release: () => Promise<void>;
    track: (operation: Promise<unknown>) => Promise<unknown>;
  }) => Promise<void>) {
    const blocker = await createVerifiedTestClient();
    const tasks: Promise<unknown>[] = [];
    let released = false;
    async function release() {
      if (!released) {
        await blocker.query("rollback");
        released = true;
      }
    }
    try {
      await blocker.query("begin");
      const { rows: [{ pid }] } = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
      await run({ blocker, pid, release, track: (operation) => {
        tasks.push(operation);
        void operation.catch(() => {});
        return operation;
      } });
    } finally {
      try { await release(); } finally {
        await blocker.end();
        await Promise.allSettled(tasks);
      }
    }
  }

  async function expectNoBooking(classSessionId: string) {
    expect((await client.query("select id from class_reservations where class_session_id=$1", [classSessionId])).rows).toEqual([]);
    expect((await client.query("select id from credit_ledger_movements where student_profile_id=$1 and movement_type='RECOVERY_CONSUMPTION'",
      [studentProfileId])).rows).toEqual([]);
    await expect(academic.getClassSessionAvailability(classSessionId)).resolves.toMatchObject({ confirmedReservations: 0, blockedSpots: 0 });
  }

  it.each(["recovery", "generic", "detail"] as const)("rejects a new %s booking when the session starts during a profile wait", async (entry) => {
    if (entry === "recovery") await grant();
    await withGate(async ({ blocker, pid, release, track }) => {
      await blocker.query("select id from student_profiles where id=$1 for update", [studentProfileId]);
      const classSessionId = await seedSession(1_100);
      const id = randomUUID();
      const booking = track(book(entry, classSessionId, id));
      await observeWait(pid);
      const { rows: [{ beforeStart }] } = await client.query(`select clock_timestamp() < starts_at_utc as "beforeStart"
        from class_sessions where id=$1`, [classSessionId]);
      expect(beforeStart).toBe(true);
      await client.query("select pg_sleep_until(starts_at_utc) from class_sessions where id=$1", [classSessionId]);
      await release();
      const error = { code: entry === "recovery" ? "session_not_future" : "session_not_reservable", expose: true };
      await expect(booking).rejects.toMatchObject(error);
      await expect(book(entry, classSessionId, id)).rejects.toMatchObject(error);
      await expectNoBooking(classSessionId);
    });
    await expect(credits.getCreditOverview(student)).resolves.toMatchObject({ availableCredits: entry === "recovery" ? 1 : 0 });
  });

  it.each(["generic", "detail", "recovery"] as const)("rejects a %s booking of a past session still marked SCHEDULED", async (entry) => {
    const classSessionId = await seedSession(-60_000);
    if (entry === "recovery") await grant();
    await expect(book(entry, classSessionId)).rejects.toMatchObject({ code: entry === "recovery" ? "session_not_future" : "session_not_reservable" });
    await expectNoBooking(classSessionId);
  });

  it("rejects exact equality at PostgreSQL precision and distinguishes the repeated Copenhagen hour", async () => {
    const { sessionStartsAfter } = await import("./reservation-admission");
    const { classSessions } = await import("@/src/infrastructure/db/schema");
    const { db } = await import("@/src/infrastructure/db/client");
    const { eq, sql } = await import("drizzle-orm");
    const classSessionId = await seedSession(60_000);
    // The two local 02:30 times on the autumn transition are different instants.
    await client.query(`update class_sessions set local_date='2031-10-26',
      starts_at_utc=timestamptz '2031-10-26 02:30:00+01', ends_at_utc=timestamptz '2031-10-26 03:30:00+01' where id=$1`,
    [classSessionId]);
    const [boundary] = await db.select({
      earlierOffset: sessionStartsAfter(sql`timestamptz '2031-10-26 02:30:00+02'`),
      justBefore: sessionStartsAfter(sql`${classSessions.startsAtUtc} - interval '1 microsecond'`),
      exact: sessionStartsAfter(classSessions.startsAtUtc),
      justAfter: sessionStartsAfter(sql`${classSessions.startsAtUtc} + interval '1 microsecond'`),
    }).from(classSessions).where(eq(classSessions.id, classSessionId));
    expect(boundary).toEqual({ earlierOffset: true, justBefore: true, exact: false, justAfter: false });
  });

  it.each(["detail", "recovery"] as const)("replays a confirmed %s booking after start without another reservation or charge", async (entry) => {
    if (entry === "recovery") await grant();
    const classSessionId = await seedSession(60_000);
    const id = randomUUID();
    const original = await book(entry, classSessionId, id) as { reservationId: string; consumedMovementId?: string };
    const past = new Date(Date.now() - 60_000);
    await academic.updateClassSession(admin, { classSessionId, startsAtUtc: past, endsAtUtc: new Date(past.getTime() + 3_600_000) });
    await expect(book(entry, classSessionId, id)).resolves.toMatchObject(entry === "recovery"
      ? { ...original, idempotent: true }
      : { ...original, created: false });
    const { rows } = await client.query("select id,created_by_user_id from class_reservations where class_session_id=$1", [classSessionId]);
    expect(rows).toEqual([{ id: original.reservationId, created_by_user_id: entry === "detail" ? admin.userId : null }]);
    const consumption = await client.query("select id from credit_ledger_movements where related_reservation_id=$1", [original.reservationId]);
    expect(consumption.rows).toEqual(entry === "recovery" ? [{ id: original.consumedMovementId }] : []);
  });

  it.each([
    ["generic", "past"], ["detail", "future"], ["recovery", "past"], ["recovery", "cancelled"],
  ] as const)("uses the committed %s booking schedule after a concurrent move to %s", async (entry, target) => {
    const classSessionId = await seedSession(target === "future" ? -60_000 : 60_000);
    if (entry === "recovery") await grant();

    await withGate(async ({ blocker, pid, release, track }) => {
      await blocker.query("select id from class_sessions where id=$1 for update", [classSessionId]);
      const startsAtUtc = new Date(Date.now() + (target === "future" ? 60_000 : -60_000));
      const edit = track(target === "cancelled" ? academic.cancelClassSession(admin, { classSessionId })
        : academic.updateClassSession(admin, { classSessionId, startsAtUtc, endsAtUtc: new Date(startsAtUtc.getTime() + 3_600_000) }));
      const editWait = await observeWait(pid);
      const booking = track(book(entry, classSessionId));
      const bookingWait = await observeWait(editWait.pid);
      expect(bookingWait.query).toContain("class_sessions");
      expect(bookingWait.query).toContain("for update");
      await release();
      await edit;
      if (target === "future") {
        await expect(booking).resolves.toMatchObject({ created: true });
        await expect(academic.getClassSessionAvailability(classSessionId)).resolves.toMatchObject({ confirmedReservations: 1 });
      } else {
        await expect(booking).rejects.toMatchObject({ code: entry === "recovery" && target === "past" ? "session_not_future" : "session_not_reservable" });
        await expectNoBooking(classSessionId);
      }
    });
  });
});

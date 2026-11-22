import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hashSessionToken } from "@/src/infrastructure/security/session-token";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

type TestConnection = Awaited<ReturnType<typeof createVerifiedTestClient>>;
type ReservationKind = "ordinary" | "recovery";

describe("H04 cancellation account lock (postgres)", () => {
  let client: TestConnection;
  let academic: typeof import("@/src/application/academic/academic-service");
  let recovery: typeof import("@/src/application/recovery/recovery-service");
  let credits: typeof import("@/src/application/credits/credit-service");
  let withdrawStudent: typeof import("@/src/application/academic/student-withdrawal").withdrawStudent;
  let getAuthenticatedUser: typeof import("@/src/application/auth/auth-service").getAuthenticatedUserFromSessionToken;
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("@/src/application/academic/academic-service");
    recovery = await import("@/src/application/recovery/recovery-service");
    credits = await import("@/src/application/credits/credit-service");
    ({ withdrawStudent } = await import("@/src/application/academic/student-withdrawal"));
    ({ getAuthenticatedUserFromSessionToken: getAuthenticatedUser } = await import("@/src/application/auth/auth-service"));
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    await client.query(`insert into users (id,email,email_normalized,password_hash,role)
      values ($1,'admin@example.com','admin@example.com','hash','SUPER_ADMIN')`, [admin.userId]);
  });

  afterAll(async () => { await client?.end(); });

  async function seedStudent() {
    const userId = randomUUID();
    const studentProfileId = randomUUID();
    const token = randomUUID();
    await client.query(`insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash','STUDENT')`,
      [userId, `${userId}@example.com`]);
    await client.query(`insert into student_profiles (id,user_id,first_name,last_name) values ($1,$2,'Test','Student')`,
      [studentProfileId, userId]);
    await client.query(`insert into sessions (id,user_id,token_hash,expires_at) values ($1,$2,$3,now()+interval '1 hour')`,
      [randomUUID(), userId, hashSessionToken(token)]);
    const actor = await getAuthenticatedUser(token);
    expect(actor).toMatchObject({ userId, role: "STUDENT" });
    return { actor: actor!, studentProfileId, token };
  }

  async function seedReservation(kind: ReservationKind, student: Awaited<ReturnType<typeof seedStudent>>,
    daysAhead: number, templateId?: string) {
    const { studentProfileId, actor } = student;
    const classSessionId = randomUUID();
    await client.query(`insert into class_sessions (id,template_id,local_date,starts_at_utc,ends_at_utc,max_capacity)
      values ($1,$2,(now() at time zone 'Europe/Copenhagen')::date+$3::int,
        now()+$3::int*interval '1 day', now()+$3::int*interval '1 day'+interval '1 hour', 12)`,
    [classSessionId, templateId ?? null, kind === "recovery" ? 14 : daysAhead]);
    if (kind === "ordinary") {
      const reservationId = randomUUID();
      await client.query(`insert into class_reservations (id,class_session_id,student_profile_id) values ($1,$2,$3)`,
        [reservationId, classSessionId, studentProfileId]);
      return { reservationId, classSessionId };
    }

    await credits.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId, amount: 1, reason: "Saldo de recuperación" });
    const { reservationId, consumedMovementId } = await recovery.reserveRecovery(actor, { classSessionId });
    if (daysAhead < 0) {
      await client.query(`update class_sessions set local_date=(now() at time zone 'Europe/Copenhagen')::date+$2::int,
        starts_at_utc=now()+$2::int*interval '1 day', ends_at_utc=now()+$2::int*interval '1 day'+interval '1 hour' where id=$1`,
      [classSessionId, daysAhead]);
    }
    return { reservationId, classSessionId, consumedMovementId };
  }

  async function seedRevisedHabitualAssignment(studentProfileId: string) {
    await client.query(`insert into academic_regulations (id,effective_from,cancellation_notice_days,monthly_cancellation_credits,
      monthly_recoveries,credit_expiration_months,max_class_capacity,max_eligible_consecutive_cancellations,previous_version_id,changes)
      select 'h04-revised',current_date-1,cancellation_notice_days,monthly_cancellation_credits,monthly_recoveries,
        credit_expiration_months,max_class_capacity,3,id,'{}'::jsonb from academic_regulations where id='initial'`);
    const templateId = randomUUID();
    await client.query(`insert into class_templates (id,name,iso_weekday,starts_at_local_time,duration_minutes,effective_from)
      values ($1,'Curso de prueba',1,'18:00',60,current_date-14)`, [templateId]);
    await client.query(`insert into student_template_assignments (id,student_profile_id,template_id,effective_from)
      values ($1,$2,$3,current_date-14)`, [randomUUID(), studentProfileId, templateId]);
    return templateId;
  }

  async function observeWait(blockers: number[], queryPattern: string, exclude?: number) {
    let waiting: { pid: number; query: string } | undefined;
    await expect.poll(async () => {
      const { rows } = await client.query<{ pid: number; query: string }>(`select pid, query from pg_stat_activity
        where datname=current_database() and state='active' and pg_blocking_pids(pid) && $1::int[]
          and query ilike $2 and pid is distinct from $3::int`, [blockers, queryPattern, exclude ?? null]);
      waiting = rows[0];
      return rows.length;
    }, { interval: 25, timeout: 3_000 }).toBe(1);
    return waiting!;
  }

  async function withLockedSession(classSessionId: string, run: (gate: {
    pid: number;
    release: () => Promise<unknown>;
    track: <T>(operation: Promise<T>) => Promise<T>;
  }) => Promise<void>) {
    const gate = await createVerifiedTestClient();
    const tasks: Promise<unknown>[] = [];
    let holding = true;
    async function release() {
      if (holding) {
        await gate.query("rollback");
        holding = false;
      }
    }
    try {
      const { rows: [{ pid }] } = await gate.query<{ pid: number }>("select pg_backend_pid() as pid");
      await gate.query("begin");
      await gate.query("select id from class_sessions where id=$1 for no key update", [classSessionId]);
      await run({ pid, release, track: (operation) => {
        tasks.push(operation);
        void operation.catch(() => {});
        return operation;
      } });
    } finally {
      try {
        await release();
      } finally {
        await gate.end();
        await Promise.allSettled(tasks);
      }
    }
  }

  const cancel = (kind: ReservationKind, actor: { userId: string; role: "STUDENT" | "SUPER_ADMIN" }, reservationId: string) =>
    kind === "ordinary" ? academic.cancelReservation(actor, { reservationId }) : recovery.cancelRecoveryReservation(actor, { reservationId });

  async function academicState(studentProfileId: string) {
    return {
      reservations: (await client.query("select * from class_reservations where student_profile_id=$1 order by id", [studentProfileId])).rows,
      cancellations: (await client.query("select * from reservation_cancellations where student_profile_id=$1 order by id", [studentProfileId])).rows,
      ledger: (await client.query("select * from credit_ledger_movements where student_profile_id=$1 order by id", [studentProfileId])).rows,
    };
  }

  it.each(["ordinary", "recovery"] as const)("rejects the already authenticated %s cancellation when withdrawal wins", async (kind) => {
    const student = await seedStudent();
    const { actor, studentProfileId, token } = student;
    // Withdrawal keeps started reservations. A stale request must not change the preserved reservation.
    const { reservationId, classSessionId } = await seedReservation(kind, student, -2);
    const before = await academicState(studentProfileId);

    await withLockedSession(classSessionId, async ({ pid, release, track }) => {
      const withdrawal = track(withdrawStudent(admin, { studentProfileId }));
      const withdrawalWait = await observeWait([pid], "%class_sessions%for no key update%");
      const cancellation = track(cancel(kind, actor, reservationId));
      const cancellationWait = await observeWait([pid, withdrawalWait.pid], "%for%", withdrawalWait.pid);
      expect(cancellationWait.pid).not.toBe(withdrawalWait.pid);
      await release();
      await expect(withdrawal).resolves.toEqual({ withdrawn: true, releasedReservations: 0, cancelledRecoveries: 0 });
      await expect(cancellation).rejects.toMatchObject({ code: "student_inactive", expose: true });
      expect(cancellationWait.query).toMatch(/for share of "users"/);
    });
    await expect(getAuthenticatedUser(token)).resolves.toBeNull();
    await expect(cancel(kind, actor, reservationId)).rejects.toMatchObject({ code: "student_inactive" });
    expect(await academicState(studentProfileId)).toEqual(before);
    const audit = await client.query("select withdrawn_by_user_id from student_withdrawals where student_user_id=$1", [actor.userId]);
    expect(audit.rows).toEqual([{ withdrawn_by_user_id: admin.userId }]);
  });

  it.each(["ordinary", "recovery"] as const)("serializes withdrawal after the %s cancellation locks the active account first", async (kind) => {
    const student = await seedStudent();
    const { actor, studentProfileId, token } = student;
    const templateId = kind === "ordinary" ? await seedRevisedHabitualAssignment(studentProfileId) : undefined;
    const earlier = templateId ? await seedReservation("ordinary", student, -2, templateId) : undefined;
    const target = await seedReservation(kind, student, 14, templateId);

    await withLockedSession(target.classSessionId, async ({ pid, release, track }) => {
      const cancellation = track(cancel(kind, actor, target.reservationId));
      const cancellationWait = await observeWait([pid], "%class_sessions%for no key update%");
      const withdrawal = track(withdrawStudent(admin, { studentProfileId }));
      await observeWait([cancellationWait.pid], '%"users"%for no key update of "users"%');
      await release();
      await expect(cancellation).resolves.toMatchObject(kind === "ordinary"
        ? { created: true, autoCreditGenerated: false, autoCreditSkippedReason: "PENDING" }
        : { cancelled: true, refunded: true, refundRestoredCredit: true });
      await expect(withdrawal).resolves.toEqual({ withdrawn: true, releasedReservations: 0, cancelledRecoveries: 0 });
    });
    await expect(getAuthenticatedUser(token)).resolves.toBeNull();
    await expect(cancel(kind, actor, target.reservationId)).rejects.toMatchObject({ code: "student_inactive" });
    const state = await academicState(studentProfileId);
    expect(state.reservations).toContainEqual(expect.objectContaining({ id: target.reservationId, status: "CANCELLED", cancelled_by_user_id: actor.userId }));
    if (earlier) {
      expect(state.cancellations).toEqual([expect.objectContaining({ reservation_id: target.reservationId,
        decision_source: "STUDENT_REQUEST", sequence_pending: true, credit_resolution: null })]);
      expect(state.ledger).toEqual([]);
      await academic.recordAttendance(admin, { ...earlier, outcome: "ABSENT" });
      const settled = await academicState(studentProfileId);
      expect(settled.cancellations).toEqual([expect.objectContaining({ sequence_pending: false, credit_resolution: "GRANTED" })]);
      expect(settled.ledger).toEqual([expect.objectContaining({ movement_type: "AUTO_CANCELLATION_GRANT", source_cancellation_id: state.cancellations[0].id })]);
    } else {
      expect(state.cancellations).toEqual([]);
      expect(state.ledger.map(({ movement_type }) => movement_type).sort()).toEqual(["MANUAL_GRANT", "RECOVERY_CONSUMPTION", "RECOVERY_REFUND"]);
      expect(state.ledger).toContainEqual(expect.objectContaining({ movement_type: "RECOVERY_REFUND",
        source_movement_id: target.consumedMovementId, related_reservation_id: target.reservationId }));
    }
  });

  it.each(["global cancellation", "rescheduling"] as const)("shares the session order with administrative %s", async (operation) => {
    const student = await seedStudent();
    const { reservationId, classSessionId } = await seedReservation("ordinary", student, 14);
    const startsAtUtc = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
    const endsAtUtc = new Date(startsAtUtc.getTime() + 60 * 60 * 1000);

    await withLockedSession(classSessionId, async ({ pid, release, track }) => {
      const administrative = track<unknown>(operation === "global cancellation"
        ? academic.cancelClassSession(admin, { classSessionId })
        : academic.updateClassSession(admin, { classSessionId, startsAtUtc, endsAtUtc }));
      const administrativeWait = await observeWait([pid], "%class_sessions%for update%");
      const cancellation = track(academic.cancelReservation(student.actor, { reservationId }));
      await observeWait([administrativeWait.pid], "%class_sessions%for no key update%");
      await release();
      await administrative;
      if (operation === "global cancellation") {
        await expect(cancellation).rejects.toMatchObject({ code: "reservation_not_confirmed" });
      } else {
        await expect(cancellation).resolves.toMatchObject({ created: true, cancellationType: "ON_TIME" });
      }
    });

    const state = await academicState(student.studentProfileId);
    expect(state.ledger).toEqual([]);
    if (operation === "global cancellation") {
      expect(state.cancellations).toEqual([]);
      expect(state.reservations).toEqual([expect.objectContaining({ status: "CANCELLED", cancelled_by_user_id: admin.userId })]);
    } else {
      expect(state.cancellations).toEqual([expect.objectContaining({ decision_source: "STUDENT_REQUEST" })]);
      const { rows } = await client.query("select starts_at_utc, edited_by_user_id from class_session_edits where class_session_id=$1", [classSessionId]);
      expect(rows).toEqual([{ starts_at_utc: startsAtUtc, edited_by_user_id: admin.userId }]);
    }
  });

  it.each(["ordinary", "recovery"] as const)("keeps %s ownership checks and allows the existing administrative action after a role change and deactivation", async (kind) => {
    const student = await seedStudent();
    const other = await seedStudent();
    const target = await seedReservation(kind, student, 14);
    const before = await academicState(student.studentProfileId);
    await expect(cancel(kind, other.actor, target.reservationId)).rejects.toMatchObject({ code: "forbidden" });
    await client.query("update users set role='SUPER_ADMIN' where id=$1", [student.actor.userId]);
    await expect(cancel(kind, student.actor, target.reservationId)).rejects.toMatchObject({ code: "student_inactive" });
    expect(await academicState(student.studentProfileId)).toEqual(before);

    // An administrative target can be inactive. Set the status directly so the fixture preserves the future reservation.
    await client.query("update users set role='STUDENT', status='DISABLED' where id=$1", [student.actor.userId]);
    if (kind === "ordinary") {
      await expect(academic.cancelSessionEnrollment(admin, { ...target, cancellationId: randomUUID(), reason: "Decisión administrativa" }))
        .resolves.toMatchObject({ created: true, autoCreditGenerated: false });
      expect((await academicState(student.studentProfileId)).cancellations).toEqual([
        expect.objectContaining({ decision_source: "ADMIN_DECISION", cancelled_by_user_id: admin.userId }),
      ]);
    } else {
      await expect(recovery.cancelRecoveryReservation(admin, target)).resolves.toMatchObject({ cancelled: true, refunded: true });
    }
  });
});

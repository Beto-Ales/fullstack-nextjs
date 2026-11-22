import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe("credits integration (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let db: typeof import("@/src/infrastructure/db/client").db;
  let service: typeof import("@/src/application/credits/credit-service");
  let schema: typeof import("@/src/infrastructure/db/schema");
  let drizzle: typeof import("drizzle-orm");

  const adminActor = { userId: randomUUID(), role: "SUPER_ADMIN" as const };

  beforeAll(async () => {
    client = await createVerifiedTestClient();

    ({ db } = await import("@/src/infrastructure/db/client"));
    service = await import("@/src/application/credits/credit-service");
    schema = await import("@/src/infrastructure/db/schema");
    drizzle = await import("drizzle-orm");

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now())
       on conflict do nothing`,
      [adminActor.userId, `${adminActor.userId}@example.com`, `${adminActor.userId}@example.com`],
    );
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now())
       on conflict do nothing`,
      [adminActor.userId, `${adminActor.userId}@example.com`, `${adminActor.userId}@example.com`],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  async function seedManualAccount(role: "SUPER_ADMIN" | "STUDENT" = "STUDENT") {
    const userId = randomUUID();
    const studentProfileId = randomUUID();
    await client.query(
      "insert into users (id, email, email_normalized, password_hash, role) values ($1, $2, $2, 'hash', $3)",
      [userId, `${userId}@example.com`, role],
    );
    if (role === "STUDENT") {
      await client.query("insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Test', 'Student')",
        [studentProfileId, userId]);
    }
    return { userId, role, studentProfileId };
  }

  async function movementsForRequest(requestId: string) {
    const { rows } = await client.query(`select id, student_profile_id, admin_user_id, amount, reason, movement_type,
      class_session_id, source_grant_movement_id, created_at from credit_ledger_movements
      where manual_request_id = $1 order by id`, [requestId]);
    return rows;
  }

  async function seedFutureSession() {
    const classSessionId = randomUUID();
    const { rows: [session] } = await client.query<{ starts_at_utc: Date; ends_at_utc: Date }>(`
      insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
      values ($1, (now() at time zone 'Europe/Copenhagen')::date + 14, now() + interval '14 days',
        now() + interval '14 days 1 hour', 12) returning starts_at_utc, ends_at_utc`, [classSessionId]);
    return { classSessionId, ...session };
  }

  async function observeWait(blockingPid: number, queryPattern: string) {
    let waiting: { pid: number; query: string } | undefined;
    await expect.poll(async () => {
      const { rows } = await client.query<{ pid: number; query: string }>(`
        select pid, query from pg_stat_activity
        where datname = current_database() and state = 'active' and query ilike $2
          and $1 = any(pg_blocking_pids(pid))`, [blockingPid, queryPattern]);
      waiting = rows[0];
      return rows.length;
    }, { interval: 30, timeout: 3_000 }).toBe(1);
    return waiting!;
  }

  async function withLockGate(run: (gate: {
    blocker: Awaited<ReturnType<typeof createVerifiedTestClient>>;
    pid: number;
    release: () => Promise<void>;
    track: <T>(operation: Promise<T>) => Promise<T>;
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
      try {
        await release();
      } finally {
        await blocker.end();
        await Promise.allSettled(tasks);
      }
    }
  }

  async function runLinkedAdjustmentBefore(
    adjust: () => Promise<unknown>,
    operateOnSession: () => Promise<unknown>,
  ) {
    await withLockGate(async ({ blocker, pid, track, release }) => {
      // SELECTs can read the ledger, but the manual INSERT waits while its row locks are held.
      await blocker.query("lock table credit_ledger_movements in share mode");
      const manual = track(adjust());
      const manualWait = await observeWait(pid, 'insert into "credit_ledger_movements"%');
      const academic = track(operateOnSession());
      const academicWait = await observeWait(manualWait.pid, "%select%");
      await release();

      const outcomes = (await Promise.allSettled([manual, academic])).map((result) => {
        if (result.status === "fulfilled") return result.status;
        const error = result.reason as { code?: string; cause?: { code?: string } };
        return error.cause?.code ?? error.code ?? String(result.reason);
      });
      expect(outcomes, academicWait.query).toEqual(["fulfilled", "fulfilled"]);
      expect(academicWait.query).toMatch(/from\s+"?class_sessions"?\s/i);
    });
  }

  describe("H02 session lock order", () => {
    it("serializes a linked grant and global cancellation, including the recovery refund", async () => {
      const { cancelClassSession } = await import("@/src/application/academic/academic-service");
      const { reserveRecovery } = await import("@/src/application/recovery/recovery-service");
      const student = await seedManualAccount();
      const { studentProfileId } = student;
      const { classSessionId } = await seedFutureSession();
      await service.grantManualCredits(adminActor, { requestId: randomUUID(), studentProfileId, amount: 2, reason: "Saldo inicial" });
      const { reservationId, consumedMovementId } = await reserveRecovery(student, { classSessionId });
      const input = { requestId: randomUUID(), studentProfileId, classSessionId, amount: 1, reason: "Ajuste y cancelación" };

      await runLinkedAdjustmentBefore(() => service.grantManualCredits(adminActor, input), () => cancelClassSession(adminActor, { classSessionId }));

      expect(await movementsForRequest(input.requestId)).toEqual([expect.objectContaining({
        class_session_id: classSessionId, admin_user_id: adminActor.userId, reason: input.reason, amount: 1,
      })]);
      const { rows } = await client.query(`select r.status, m.source_movement_id, m.refund_restored_credit
        from class_reservations r join credit_ledger_movements m on m.related_reservation_id = r.id
        where r.id = $1 and m.movement_type = 'RECOVERY_REFUND'`, [reservationId]);
      expect(rows).toEqual([{ status: "CANCELLED", source_movement_id: consumedMovementId, refund_restored_credit: true }]);
      await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 3 });
    });

    it("serializes a linked multi-grant withdrawal and rescheduling with an existing reservation", async () => {
      const { updateClassSession } = await import("@/src/application/academic/academic-service");
      const { studentProfileId } = await seedManualAccount();
      const session = await seedFutureSession();
      const { classSessionId } = session;
      const reservationId = randomUUID();
      await client.query("insert into class_reservations (id, class_session_id, student_profile_id) values ($1, $2, $3)",
        [reservationId, classSessionId, studentProfileId]);
      const seedGrant = () => service.grantManualCredits(adminActor,
        { requestId: randomUUID(), studentProfileId, amount: 1, reason: "Saldo para retirada" });
      const first = await seedGrant();
      const second = await seedGrant();
      const input = { requestId: randomUUID(), studentProfileId, classSessionId, amount: 2, reason: "Retirada y reprogramación" };
      const startsAtUtc = new Date(session.starts_at_utc.getTime() + 60 * 60 * 1000);
      const endsAtUtc = new Date(session.ends_at_utc.getTime() + 60 * 60 * 1000);

      await runLinkedAdjustmentBefore(() => service.withdrawManualCredits(adminActor, input),
        () => updateClassSession(adminActor, { classSessionId, startsAtUtc, endsAtUtc }));

      expect(await movementsForRequest(input.requestId)).toEqual(expect.arrayContaining([first, second].map(({ movementId }) =>
        expect.objectContaining({ amount: 1, class_session_id: classSessionId,
          movement_type: "MANUAL_WITHDRAWAL", source_grant_movement_id: movementId }))));
      const replay = await service.withdrawManualCredits(adminActor, input);
      expect(replay.movementIds).toHaveLength(2);
      const { rows } = await client.query(`select r.status, e.starts_at_utc, e.edited_by_user_id
        from class_reservations r join class_session_edits e on e.class_session_id = r.class_session_id
        where r.id = $1`, [reservationId]);
      expect(rows).toEqual([{ status: "CONFIRMED", starts_at_utc: startsAtUtc, edited_by_user_id: adminActor.userId }]);
      await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 0 });
    });

    it("serializes a linked grant and a recovery booking that immediately spends that credit", async () => {
      const { reserveRecovery } = await import("@/src/application/recovery/recovery-service");
      const student = await seedManualAccount();
      const { studentProfileId } = student;
      const { classSessionId } = await seedFutureSession();
      const input = { requestId: randomUUID(), studentProfileId, classSessionId, amount: 1, reason: "Ajuste y recuperación" };

      await runLinkedAdjustmentBefore(() => service.grantManualCredits(adminActor, input), () => reserveRecovery(student, { classSessionId }));

      const { movementId } = await service.grantManualCredits(adminActor, input);
      const { rows } = await client.query(`select r.status, m.source_grant_movement_id from class_reservations r
        join credit_ledger_movements m on m.related_reservation_id = r.id and m.movement_type = 'RECOVERY_CONSUMPTION'
        where r.class_session_id = $1 and r.student_profile_id = $2`, [classSessionId, studentProfileId]);
      expect(rows).toEqual([{ status: "CONFIRMED", source_grant_movement_id: movementId }]);
      await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 0 });
    });

    it("shares the session key with a recovery cancellation already waiting on the profile", async () => {
      const { reserveRecovery, cancelRecoveryReservation } = await import("@/src/application/recovery/recovery-service");
      const student = await seedManualAccount();
      const { studentProfileId } = student;
      const { classSessionId } = await seedFutureSession();
      const input = { requestId: randomUUID(), studentProfileId, classSessionId, amount: 1, reason: "Ajuste y devolución" };
      await service.grantManualCredits(adminActor, { ...input, requestId: randomUUID(), classSessionId: undefined });
      const { reservationId } = await reserveRecovery(student, { classSessionId });

      await withLockGate(async ({ blocker, pid, track, release }) => {
        await blocker.query("select id from student_profiles where id = $1 for update", [studentProfileId]);
        const cancellation = track(cancelRecoveryReservation(student, { reservationId }));
        const cancellationWait = await observeWait(pid, "%from student_profiles%for update%");
        const grant = track(service.grantManualCredits(adminActor, input));
        // A second writer queues on the row behind the first after taking the compatible session key lock.
        await observeWait(cancellationWait.pid, "%from student_profiles%for update%");
        await release();
        await expect(cancellation).resolves.toMatchObject({ cancelled: true, refunded: true });
        await expect(grant).resolves.toMatchObject({ movementId: expect.any(String) });
      });
      await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 2 });
    });

    it("keeps other adjustments and confirmed replays independent of an exclusively locked session", async () => {
      const { studentProfileId } = await seedManualAccount();
      const { classSessionId } = await seedFutureSession();
      const other = await seedFutureSession();
      const input = { requestId: randomUUID(), studentProfileId, classSessionId, amount: 1, reason: "Sesión bloqueada" };
      const confirmed = { ...input, requestId: randomUUID() };
      const original = await service.grantManualCredits(adminActor, confirmed);

      await withLockGate(async ({ blocker, pid, track, release }) => {
        await blocker.query("select id from class_sessions where id = $1 for update", [classSessionId]);
        const first = track(service.grantManualCredits(adminActor, input));
        const waiting = await observeWait(pid, "%from%class_sessions%for key share%");
        const replay = track(service.grantManualCredits(adminActor, input));
        await observeWait(waiting.pid, 'insert into "manual_credit_adjustment_requests"%');

        await expect(track(service.grantManualCredits(adminActor, { ...input, requestId: randomUUID(), classSessionId: undefined })))
          .resolves.toMatchObject({ movementId: expect.any(String) });
        await expect(track(service.withdrawManualCredits(adminActor, { ...input, requestId: randomUUID(), classSessionId: undefined })))
          .resolves.toMatchObject({ movementIds: [expect.any(String)] });
        await expect(track(service.grantManualCredits(adminActor, { ...input, requestId: randomUUID(), classSessionId: other.classSessionId })))
          .resolves.toMatchObject({ movementId: expect.any(String) });

        await blocker.query("select id from student_profiles where id = $1 for update", [studentProfileId]);
        await expect(track(service.grantManualCredits(adminActor, confirmed))).resolves.toEqual(original);
        await expect(track(service.grantManualCredits(adminActor, { ...confirmed, amount: 2 })))
          .rejects.toMatchObject({ code: "manual_credit_request_conflict" });
        await release();
        expect(await replay).toEqual(await first);
      });
      await expect(movementsForRequest(input.requestId)).resolves.toHaveLength(1);
      await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 3 });
    });

    it("rolls back the request when its linked session does not exist", async () => {
      const { studentProfileId } = await seedManualAccount();
      const input = { requestId: randomUUID(), studentProfileId, classSessionId: randomUUID(), amount: 1, reason: "Referencia inexistente" };
      await expect(service.grantManualCredits(adminActor, input)).rejects.toMatchObject({ code: "session_not_found" });
      await expect(movementsForRequest(input.requestId)).resolves.toEqual([]);
      expect((await client.query("select id from manual_credit_adjustment_requests where id = $1", [input.requestId])).rowCount).toBe(0);
    });
  });

  async function withBlockedProfile<T>(studentProfileId: string, start: () => Promise<T>, sameRequest: boolean) {
    const blocker = await createVerifiedTestClient();
    let result: Promise<T> | undefined;
    try {
      const { rows: [{ pid }] } = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
      await blocker.query("begin");
      await blocker.query("select id from student_profiles where id = $1 for update", [studentProfileId]);
      result = start();
      void result.catch(() => {});
      await expect.poll(async () => {
        const { rows: [waiters] } = await client.query<{ profile: number; blockedDirectly: boolean; request: number }>(`
          with activity as (
            select pid, query, pg_blocking_pids(pid) as waits_for from pg_stat_activity
            where datname = current_database() and state = 'active'
          ), waiting_on_profile as (
            select pid, waits_for from activity where cardinality(waits_for) > 0 and query like '%from student_profiles%'
          )
          select (select count(*)::int from waiting_on_profile) as profile,
            exists(select 1 from waiting_on_profile where $1 = any(waits_for)) as "blockedDirectly",
            (count(*) filter (where query like 'insert into "manual_credit_adjustment_requests"%'
              and waits_for && array(select pid from waiting_on_profile)))::int as request
          from activity`, [pid]);
        return waiters;
      }, { timeout: 3_000 }).toEqual(sameRequest ? { profile: 1, blockedDirectly: true, request: 1 }
        : { profile: 2, blockedDirectly: true, request: 0 });
    } finally {
      try {
        await blocker.query("rollback");
      } finally {
        await blocker.end();
      }
      await result?.catch(() => {});
    }
    return result!;
  }

  it("persists one normalized grant and returns its original result after replay", async () => {
    const { studentProfileId } = await seedManualAccount();
    const input = { requestId: randomUUID(), studentProfileId, amount: 2, reason: "  Corrección inicial  " };
    const original = await service.grantManualCredits(adminActor, input);
    await expect(service.grantManualCredits(adminActor, { ...input, reason: "Corrección inicial" })).resolves.toEqual(original);
    await expect(movementsForRequest(input.requestId)).resolves.toEqual([expect.objectContaining({ id: original.movementId,
      student_profile_id: studentProfileId, admin_user_id: adminActor.userId, reason: "Corrección inicial", amount: 2,
      movement_type: "MANUAL_GRANT", created_at: expect.any(Date) })]);
    const second = await service.grantManualCredits(adminActor, { ...input, requestId: randomUUID() });
    expect(second.movementId).not.toBe(original.movementId);
    await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 4 });
    await expect(client.query(`insert into manual_credit_adjustment_requests select * from manual_credit_adjustment_requests where id = $1`,
      [input.requestId])).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects changed quantity, student, reason, session, kind or administrator without disclosing the result", async () => {
    const { studentProfileId } = await seedManualAccount();
    const otherStudent = await seedManualAccount();
    const otherAdmin = await seedManualAccount("SUPER_ADMIN");
    const { rows: [session] } = await client.query(`insert into class_sessions
      (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
      values ($1, current_date+1, now()+interval '1 day', now()+interval '25 hours', 12) returning id`, [randomUUID()]);
    const input = { requestId: randomUUID(), studentProfileId, amount: 2, reason: "Ajuste original", classSessionId: session.id };
    const original = await service.grantManualCredits(adminActor, input);
    for (const changed of [{ amount: 1 }, { studentProfileId: otherStudent.studentProfileId }, { reason: "Otro motivo" },
      { classSessionId: undefined }]) {
      await expect(service.grantManualCredits(adminActor, { ...input, ...changed })).rejects.toMatchObject({ code: "manual_credit_request_conflict" });
    }
    await expect(service.withdrawManualCredits(adminActor, input)).rejects.toMatchObject({ code: "manual_credit_request_conflict" });
    await expect(service.grantManualCredits(otherAdmin, input)).rejects.toMatchObject({ code: "manual_credit_request_conflict" });
    await expect(movementsForRequest(input.requestId)).resolves.toEqual([expect.objectContaining({ id: original.movementId,
      class_session_id: session.id, amount: 2 })]);
    await expect(service.getCreditOverview(adminActor, { studentProfileId: otherStudent.studentProfileId }))
      .resolves.toMatchObject({ availableCredits: 0 });
  });

  it("rechecks the role and current administrative status on replay and student eligibility on new requests", async () => {
    const student = await seedManualAccount();
    const input = { requestId: randomUUID(), studentProfileId: student.studentProfileId, amount: 1, reason: "Ajuste autorizado" };
    await service.grantManualCredits(adminActor, input);
    await expect(service.grantManualCredits(student, input)).rejects.toMatchObject({ code: "forbidden" });
    await client.query("update users set status = 'DISABLED' where id = $1", [student.userId]);
    await expect(service.grantManualCredits(adminActor, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: "student_not_active" });
    await client.query("update users set status = 'DISABLED' where id = $1", [adminActor.userId]);
    await expect(service.grantManualCredits(adminActor, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(movementsForRequest(input.requestId)).resolves.toHaveLength(1);
  });

  it("coalesces simultaneous grants while PostgreSQL holds the profile and the second connection waits on the request", async () => {
    const { studentProfileId } = await seedManualAccount();
    const input = { requestId: randomUUID(), studentProfileId, amount: 2, reason: "Concesión simultánea" };
    const [first, second] = await withBlockedProfile(studentProfileId, () => Promise.all([
      service.grantManualCredits(adminActor, input), service.grantManualCredits(adminActor, input),
    ]), true);
    expect(first).toEqual(second);
    await expect(movementsForRequest(input.requestId)).resolves.toHaveLength(1);
    await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 2 });
  });

  it("replays a concurrent multi-grant withdrawal and preserves historical credits and later intentional withdrawals", async () => {
    const { studentProfileId } = await seedManualAccount();
    const historicalId = randomUUID();
    await client.query(`insert into credit_ledger_movements
      (id, student_profile_id, movement_type, amount, created_at, reason, admin_user_id, source_grant_movement_id, idempotency_key)
      values ($1, $2, 'MANUAL_GRANT', 1, '2025-01-01T10:00:00Z', 'Histórico', $3, $1, $1)`,
    [historicalId, studentProfileId, adminActor.userId]);
    const readHistorical = async () => (await client.query("select * from credit_ledger_movements where id = $1", [historicalId])).rows;
    const historical = await readHistorical();
    const newGrant = await service.grantManualCredits(adminActor, { requestId: randomUUID(), studentProfileId, amount: 3, reason: "Segundo crédito" });
    const input = { requestId: randomUUID(), studentProfileId, amount: 2, reason: "Retirada de dos créditos" };
    const [first, second] = await withBlockedProfile(studentProfileId, () => Promise.all([
      service.withdrawManualCredits(adminActor, input), service.withdrawManualCredits(adminActor, input),
    ]), true);
    expect(first).toEqual(second);
    await expect(service.withdrawManualCredits(adminActor, input)).resolves.toEqual(first);
    expect(await movementsForRequest(input.requestId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount: 1, movement_type: "MANUAL_WITHDRAWAL", source_grant_movement_id: historicalId }),
      expect.objectContaining({ amount: 1, movement_type: "MANUAL_WITHDRAWAL", source_grant_movement_id: newGrant.movementId }),
    ]));
    expect(first.movementIds).toHaveLength(2);
    const next = await service.withdrawManualCredits(adminActor, { ...input, requestId: randomUUID() });
    expect(next.movementIds).toHaveLength(1);
    await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 0 });
    expect(await readHistorical()).toEqual(historical);
  });

  it("rolls back a multi-grant withdrawal after a later movement fails and permits retry with the original key", async () => {
    const { studentProfileId } = await seedManualAccount();
    await client.query(`insert into credit_ledger_movements
      (id, student_profile_id, movement_type, amount, created_at, reason, admin_user_id, source_grant_movement_id, idempotency_key)
      values ($1, $3, 'MANUAL_GRANT', 1, '2025-01-01', 'Crédito anterior', $4, $1, $1),
        ($2, $3, 'MANUAL_GRANT', 2, '2025-01-02', 'Crédito posterior', $4, $2, $2)`,
    [randomUUID(), randomUUID(), studentProfileId, adminActor.userId]);
    const input = { requestId: randomUUID(), studentProfileId, amount: 3, reason: "Retirada con fallo controlado" };
    await client.query(`alter table credit_ledger_movements add constraint test_manual_rollback
      check (movement_type <> 'MANUAL_WITHDRAWAL' or amount <> 2) not valid`);
    try {
      await expect(service.withdrawManualCredits(adminActor, input)).rejects.toMatchObject({ cause: { code: "23514" } });
    } finally {
      await client.query("alter table credit_ledger_movements drop constraint test_manual_rollback");
    }
    await expect(movementsForRequest(input.requestId)).resolves.toEqual([]);
    expect((await client.query("select id from manual_credit_adjustment_requests where id = $1", [input.requestId])).rowCount).toBe(0);
    await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 3 });
    const result = await service.withdrawManualCredits(adminActor, input);
    expect(result.movementIds).toHaveLength(2);
  });

  it("serializes a recovery and a manual withdrawal against the same last credit", async () => {
    const student = await seedManualAccount();
    const { studentProfileId } = student;
    const sessionId = randomUUID();
    await client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
      values ($1, current_date+1, now()+interval '1 day', now()+interval '25 hours', 12)`, [sessionId]);
    await service.grantManualCredits(adminActor, { requestId: randomUUID(), studentProfileId, amount: 1, reason: "Último crédito" });
    const { reserveRecovery } = await import("@/src/application/recovery/recovery-service");
    const results = await withBlockedProfile(studentProfileId, () => Promise.allSettled([
      service.withdrawManualCredits(adminActor, { requestId: randomUUID(), studentProfileId, amount: 1, reason: "Retirada concurrente" }),
      reserveRecovery(student, { classSessionId: sessionId }),
    ]), false);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    await expect(service.getCreditOverview(adminActor, { studentProfileId })).resolves.toMatchObject({ availableCredits: 0 });
  });

  async function seedCancellationCandidate(cancelledAtIso: string) {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();
    const templateId = randomUUID();
    const sessionId = randomUUID();
    const reservationId = randomUUID();
    const cancellationId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Credit', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );
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
        ($1, $2, '2026-02-04', '2026-02-04T17:00:00Z', '2026-02-04T18:00:00Z', 'SCHEDULED', 12, false, now(), now())`,
      [sessionId, templateId],
    );
    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CANCELLED', 'ORDINARY', now(), now())`,
      [reservationId, sessionId, studentProfileId],
    );
    await client.query(
      `insert into reservation_cancellations
        (id, reservation_id, student_profile_id, class_session_id, cancelled_by_user_id, cancelled_at, cancellation_type, hours_before_start,
         meets_seven_day_rule, is_habitual_reservation, sequence_id, sequence_position, is_third_cancellation, can_generate_credit_candidate,
         non_eligibility_reason, created_at, updated_at)
       values
        ($1, $2, $3, $4, $5, $6, 'ON_TIME', 200, true, true, 'seq-1', 3, true, true, null, now(), now())`,
      [cancellationId, reservationId, studentProfileId, sessionId, adminActor.userId, cancelledAtIso],
    );

    return { studentProfileId, cancellationId };
  }

  it("enforces idempotency for automatic generation", async () => {
    const seeded = await seedCancellationCandidate("2026-02-01T10:00:00.000Z");

    await db.transaction((tx) => service.tryGenerateAutoCreditFromCancellation(tx, seeded.cancellationId));
    await db.transaction((tx) => service.tryGenerateAutoCreditFromCancellation(tx, seeded.cancellationId));

    const [countResult] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(
        drizzle.and(
          drizzle.eq(schema.creditLedgerMovements.studentProfileId, seeded.studentProfileId),
          drizzle.eq(schema.creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
        ),
      );

    expect(Number(countResult?.count ?? 0)).toBe(1);
  });

  it("keeps monthly automatic generation capped at 2 under concurrency", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();
    const cancellationIds = [randomUUID(), randomUUID(), randomUUID()];

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Concurrent', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    for (const cancellationId of cancellationIds) {
      const templateId = randomUUID();
      const sessionId = randomUUID();
      const reservationId = randomUUID();
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
          ($1, $2, '2026-02-04', '2026-02-04T17:00:00Z', '2026-02-04T18:00:00Z', 'SCHEDULED', 12, false, now(), now())`,
        [sessionId, templateId],
      );
      await client.query(
        `insert into class_reservations
          (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
         values
          ($1, $2, $3, 'CANCELLED', 'ORDINARY', now(), now())`,
        [reservationId, sessionId, studentProfileId],
      );
      await client.query(
        `insert into reservation_cancellations
          (id, reservation_id, student_profile_id, class_session_id, cancelled_by_user_id, cancelled_at, cancellation_type, hours_before_start,
           meets_seven_day_rule, is_habitual_reservation, sequence_id, sequence_position, is_third_cancellation, can_generate_credit_candidate,
           non_eligibility_reason, created_at, updated_at)
         values
          ($1, $2, $3, $4, $5, '2026-02-01T10:00:00.000Z', 'ON_TIME', 200, true, true, 'seq-1', 3, true, true, null, now(), now())`,
        [cancellationId, reservationId, studentProfileId, sessionId, adminActor.userId],
      );
    }

    await Promise.all(
      cancellationIds.map((id) => db.transaction((tx) => service.tryGenerateAutoCreditFromCancellation(tx, id))),
    );

    const [countResult] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(
        drizzle.and(
          drizzle.eq(schema.creditLedgerMovements.studentProfileId, studentProfileId),
          drizzle.eq(schema.creditLedgerMovements.movementType, "AUTO_CANCELLATION_GRANT"),
        ),
      );

    expect(Number(countResult?.count ?? 0)).toBe(2);
  });

  it("serializes concurrent withdrawals and blocks overdraft", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Withdraw', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await service.grantManualCredits(adminActor, {
      requestId: randomUUID(),
      studentProfileId,
      amount: 4,
      reason: "Seed for withdrawal test",
    });

    const results = await Promise.allSettled([
      service.withdrawManualCredits(adminActor, {
        requestId: randomUUID(),
        studentProfileId,
        amount: 3,
        reason: "Withdrawal A",
      }),
      service.withdrawManualCredits(adminActor, {
        requestId: randomUUID(),
        studentProfileId,
        amount: 3,
        reason: "Withdrawal B",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it("rolls back failed withdrawals without partial movement writes", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Rollback', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await service.grantManualCredits(adminActor, {
      requestId: randomUUID(),
      studentProfileId,
      amount: 1,
      reason: "Seed for rollback",
    });

    const [before] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.studentProfileId, studentProfileId));

    await expect(
      service.withdrawManualCredits(adminActor, {
        requestId: randomUUID(),
        studentProfileId,
        amount: 2,
        reason: "Should fail",
      }),
    ).rejects.toBeDefined();

    const [after] = await db
      .select({ count: drizzle.sql<number>`count(*)::int` })
      .from(schema.creditLedgerMovements)
      .where(drizzle.eq(schema.creditLedgerMovements.studentProfileId, studentProfileId));

    expect(Number(after?.count ?? 0)).toBe(Number(before?.count ?? 0));
  });

  it("reports zero ledger integrity issues for valid manual movements", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Integrity', 'Valid', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await service.grantManualCredits(adminActor, {
      requestId: randomUUID(),
      studentProfileId,
      amount: 2,
      reason: "Valid audit movement",
    });

    const report = await service.getLedgerIntegrityReport(adminActor, { studentProfileId });
    expect(report.orphanRecoveryConsumptions).toBe(0);
    expect(report.orphanRecoveryRefunds).toBe(0);
    expect(report.duplicateRecoveryRefunds).toBe(0);
    expect(report.manualMovementsMissingAudit).toBe(0);
  });

  it("detects malformed ledger movements with integrity report query", async () => {
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [studentUserId, `${studentUserId}@example.com`, `${studentUserId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Integrity', 'Broken', now(), now())`,
      [studentProfileId, studentUserId],
    );

    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, reason, idempotency_key)
       values
        ($1, $2, 'RECOVERY_CONSUMPTION', 1, now(), 'broken consumption', $3)`,
      [randomUUID(), studentProfileId, `broken-consumption:${randomUUID()}`],
    );
    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, reason, source_grant_movement_id, refund_restored_credit, idempotency_key)
       values
        ($1, $2, 'RECOVERY_REFUND', 1, now(), 'broken refund', null, false, $3)`,
      [randomUUID(), studentProfileId, `broken-refund:${randomUUID()}`],
    );
    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, idempotency_key)
       values
        ($1, $2, 'MANUAL_GRANT', 1, now(), $3)`,
      [randomUUID(), studentProfileId, `broken-manual:${randomUUID()}`],
    );

    const report = await service.getLedgerIntegrityReport(adminActor, { studentProfileId });
    expect(report.orphanRecoveryConsumptions).toBeGreaterThan(0);
    expect(report.orphanRecoveryRefunds).toBeGreaterThan(0);
    expect(report.manualMovementsMissingAudit).toBeGreaterThan(0);
  });
});


import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { INITIAL_REGULATION } from "@/src/domain/academic/regulation";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe("administrative capacity blocks (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academic: typeof import("./academic-service");
  let calendar: typeof import("./admin-calendar-service");
  let recovery: typeof import("@/src/application/recovery/recovery-service");
  let credits: typeof import("@/src/application/credits/credit-service");
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" } as const;
  const otherAdmin = { userId: randomUUID(), role: "SUPER_ADMIN" } as const;
  const student = { userId: randomUUID(), role: "STUDENT" } as const;
  const profileId = randomUUID();
  const now = new Date("2031-04-01T15:00:00Z");
  const start = new Date("2031-04-10T15:00:00Z");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("./academic-service");
    calendar = await import("./admin-calendar-service");
    recovery = await import("@/src/application/recovery/recovery-service");
    credits = await import("@/src/application/credits/credit-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    vi.setSystemTime(now);
    await client.query(`insert into users (id, email, email_normalized, password_hash, role)
      values ($1, 'first@example.com', 'first@example.com', 'test', 'SUPER_ADMIN'),
             ($2, 'second@example.com', 'second@example.com', 'test', 'SUPER_ADMIN'),
             ($3, 'student@example.com', 'student@example.com', 'test', 'STUDENT')`,
    [admin.userId, otherAdmin.userId, student.userId]);
    await client.query(`insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'Test', 'Student')`,
      [profileId, student.userId]);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await client?.end(); });

  async function seedSession(capacity = 1, status = "SCHEDULED", startsAt = start) {
    const id = randomUUID();
    await client.query(`insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity, status)
      values ($1, $2, $3, $4, $5, $6)`, [id, startsAt.toISOString().slice(0, 10), startsAt,
      new Date(startsAt.getTime() + 3_600_000), capacity, status]);
    return id;
  }

  function request(classSessionId: string, blockedSpots = 1) {
    return { classSessionId, blockId: randomUUID(), blockedSpots, reason: "Actividad especial" };
  }

  async function expectAvailability(id: string, blockedSpots: number, confirmedReservations: number, reservableSpots: number) {
    const details = await calendar.getAdminCalendarSessionDetails(admin, id);
    const weekly = await calendar.listAdminCalendarSessions(admin, new Date("2031-04-01"), new Date("2031-04-13"), new Date());
    const expected = { blockedSpots, confirmedReservations, reservableSpots };
    expect(details?.capacityOverview).toMatchObject(expected);
    expect(weekly.find((session) => session.id === id)).toMatchObject(expected);
    return details!;
  }

  async function expectOnlyOneSuccess(operations: Promise<unknown>[], rejectedCodes: string[]) {
    const results = await Promise.allSettled(operations);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejectedCodes).toContain(rejected?.reason.code);
    return results;
  }

  it("stores creation and release audit, maintains reservations, and reopens capacity exactly once", async () => {
    const id = await seedSession(4);
    const { reservationId } = await academic.createReservation(admin, { classSessionId: id, studentProfileId: profileId, origin: "ORDINARY" });
    const first = request(id);
    const second = request(id, 2);
    await expect(academic.addSessionCapacityBlock(admin, { ...first, reason: ` ${first.reason} ` }))
      .resolves.toEqual({ blockId: first.blockId, created: true });
    await expectAvailability(id, 1, 1, 2);
    await academic.addSessionCapacityBlock(admin, second);
    await expectAvailability(id, 3, 1, 0);
    await expect(academic.addSessionCapacityBlock(admin, request(id))).rejects.toMatchObject({ code: "capacity_conflict" });

    const releasedAt = new Date("2031-04-02T15:00:00Z");
    vi.setSystemTime(releasedAt);
    const release = { classSessionId: id, blockId: second.blockId, reason: "Actividad cancelada" };
    await expect(academic.releaseSessionCapacityBlock(otherAdmin, release)).resolves.toMatchObject({ released: true });
    await expect(academic.releaseSessionCapacityBlock(admin, { ...release, reason: "Segundo intento" })).resolves.toMatchObject({ released: false });
    await expect(academic.addSessionCapacityBlock(admin, second)).resolves.toMatchObject({ created: false });
    const detail = await expectAvailability(id, 1, 1, 2);
    expect(detail.capacityBlocks).toMatchObject([
      { id: first.blockId, isActive: true, reason: first.reason, createdAt: now, createdBy: "first@example.com", releasedAt: null },
      { id: second.blockId, isActive: false, reason: second.reason, createdAt: now, createdBy: "first@example.com",
        releasedAt, releaseReason: release.reason, releasedBy: "second@example.com" },
    ]);
    expect(detail.enrollments).toMatchObject([{ reservationId, status: "CONFIRMED", attendanceOutcome: null }]);
    const { rows } = await client.query("select movement_type from credit_ledger_movements");
    expect(rows).toEqual([]);
  });

  it.each([
    ["CANCELLED", start], ["COMPLETED", new Date("2031-04-01T10:00Z")],
    ["SCHEDULED", new Date("2031-04-01T10:00Z")], ["SCHEDULED", now],
  ] as const)("rejects a new block in status %s at %s", async (status, startsAt) => {
    const id = await seedSession(12, status, startsAt);
    await expect(academic.addSessionCapacityBlock(admin, request(id))).rejects.toMatchObject({ code: "session_not_reservable" });
    expect((await calendar.getAdminCalendarSessionDetails(admin, id))?.capacityBlocks).toEqual([]);
  });

  it("validates role, session membership, UUID and both reasons", async () => {
    const id = await seedSession();
    const other = await seedSession();
    const input = request(id);
    const missing = randomUUID();
    const release = { classSessionId: id, blockId: input.blockId, reason: "Liberación de prueba" };
    await expect(academic.addSessionCapacityBlock(student, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(academic.releaseSessionCapacityBlock(student, release)).rejects.toMatchObject({ code: "forbidden" });
    await expect(academic.addSessionCapacityBlock(admin, request(missing))).rejects.toMatchObject({ code: "session_not_found" });
    await expect(academic.releaseSessionCapacityBlock(admin, { ...release, classSessionId: missing })).rejects.toMatchObject({ code: "session_not_found" });
    await expect(academic.releaseSessionCapacityBlock(admin, release)).rejects.toMatchObject({ code: "capacity_block_not_found" });
    for (const reason of [undefined, "", "   ", "ab", "a".repeat(301)]) {
      await expect(academic.addSessionCapacityBlock(admin, { ...input, reason })).rejects.toMatchObject({ name: "ZodError" });
    }
    await expect(academic.addSessionCapacityBlock(admin, { ...input, blockedSpots: 0 })).rejects.toMatchObject({ name: "ZodError" });
    await expect(academic.addSessionCapacityBlock(admin, { ...input, blockId: "malformed" })).rejects.toMatchObject({ name: "ZodError" });
    await academic.addSessionCapacityBlock(admin, input);
    await expect(academic.releaseSessionCapacityBlock(admin, { ...release, reason: "   " })).rejects.toMatchObject({ name: "ZodError" });
    await expect(academic.releaseSessionCapacityBlock(admin, { ...release, classSessionId: other })).rejects.toMatchObject({ code: "capacity_block_not_found" });
    await expectAvailability(id, 1, 0, 0);
  });

  it("serializes two administrations competing for the last spot", async () => {
    const id = await seedSession();
    await expectOnlyOneSuccess([
      academic.addSessionCapacityBlock(admin, request(id)), academic.addSessionCapacityBlock(otherAdmin, request(id)),
    ], ["capacity_conflict"]);
    await expectAvailability(id, 1, 0, 0);
  });

  it("persists simultaneous replays once and rejects reuse for changed inputs", async () => {
    const id = await seedSession(3);
    const other = await seedSession();
    const input = request(id);
    const results = await Promise.all(Array.from({ length: 3 }, () => academic.addSessionCapacityBlock(admin, input)));
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results.every(({ blockId }) => blockId === input.blockId)).toBe(true);
    await expect(academic.addSessionCapacityBlock(admin, { ...input, classSessionId: other })).rejects.toMatchObject({ code: "block_id_conflict" });
    await expect(academic.addSessionCapacityBlock(admin, { ...input, reason: "Distinto motivo" })).rejects.toMatchObject({ code: "block_id_conflict" });
    await expect(academic.addSessionCapacityBlock(otherAdmin, input)).rejects.toMatchObject({ code: "block_id_conflict" });
    await expectAvailability(id, 1, 0, 2);
  });

  it.each(["ORDINARY", "MAKEUP"] as const)("shares the last spot with a concurrent %s reservation", async (origin) => {
    const id = await seedSession();
    if (origin === "MAKEUP") await credits.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId: profileId, amount: 1, reason: "Crédito de prueba" });
    const booking = origin === "ORDINARY"
      ? academic.createReservation(admin, { classSessionId: id, studentProfileId: profileId, origin })
      : recovery.reserveRecovery(student, { classSessionId: id, idempotencyKey: randomUUID() });
    const results = await expectOnlyOneSuccess([booking, academic.addSessionCapacityBlock(admin, request(id))],
      ["capacity_conflict", "no_spots_available"]);
    const reserved = results[0].status === "fulfilled" ? 1 : 0;
    await expectAvailability(id, 1 - reserved, reserved, 0);
    if (origin === "MAKEUP") {
      const { rows } = await client.query("select id from credit_ledger_movements where movement_type = 'RECOVERY_CONSUMPTION'");
      expect(rows).toHaveLength(reserved);
    }
  });

  it("releases concurrently with a reservation and records the first release attempt only", async () => {
    const id = await seedSession();
    const input = request(id);
    await academic.addSessionCapacityBlock(admin, input);
    const release = { classSessionId: id, blockId: input.blockId, reason: "Liberación de prueba" };
    const [released, duplicate, booking] = await Promise.allSettled([
      academic.releaseSessionCapacityBlock(admin, release), academic.releaseSessionCapacityBlock(otherAdmin, release),
      academic.createReservation(admin, { classSessionId: id, studentProfileId: profileId, origin: "ORDINARY" }),
    ]);
    expect([released, duplicate]).toContainEqual(expect.objectContaining({ status: "fulfilled", value: { blockId: input.blockId, released: true } }));
    expect([released, duplicate]).toContainEqual(expect.objectContaining({ status: "fulfilled", value: { blockId: input.blockId, released: false } }));
    const confirmed = booking.status === "fulfilled" ? 1 : 0;
    if (booking.status === "rejected") expect(booking.reason).toMatchObject({ code: "no_spots_available" });
    const detail = await expectAvailability(id, 0, confirmed, 1 - confirmed);
    expect(detail.capacityBlocks).toMatchObject([{ id: input.blockId, isActive: false, releaseReason: release.reason }]);
  });

  it("rechecks capacity after waiting for the session and permits releases above the effective limit", async () => {
    const id = await seedSession(3);
    const first = request(id, 2);
    await academic.addSessionCapacityBlock(admin, first);
    const { publishAcademicRegulation } = await import("./regulation-service");
    await publishAcademicRegulation(admin, { ...INITIAL_REGULATION, effectiveFrom: "2031-04-02", maxClassCapacity: 1 });
    await client.query("begin");
    await client.query("select id from class_sessions where id = $1 for update", [id]);
    const waiting = Promise.allSettled([academic.addSessionCapacityBlock(admin, request(id))]);
    try {
      await vi.waitFor(async () => {
        await client.query("select pg_stat_clear_snapshot()");
        const { rows } = await client.query(`select pid from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and query like '%"class_sessions"%for update%'`);
        expect(rows).toHaveLength(1);
      }, { interval: 20, timeout: 2000 });
      vi.setSystemTime(new Date("2031-04-02T15:00Z"));
    } finally {
      await client.query("commit");
    }
    expect(await waiting).toMatchObject([{ status: "rejected", reason: { code: "capacity_conflict" } }]);
    expect((await expectAvailability(id, 2, 0, 0)).capacityOverview.capacityExcess).toBe(1);
    await academic.releaseSessionCapacityBlock(admin, { classSessionId: id, blockId: first.blockId, reason: "Ajuste a normativa" });
    await expectAvailability(id, 0, 0, 1);
  });

  it("filters blocked places from recovery, then reflects cancellation and a confirmed recovery", async () => {
    const id = await seedSession();
    const input = request(id);
    await academic.addSessionCapacityBlock(admin, input);
    expect((await recovery.listFutureRecoveryOptions(student)).sessions).toEqual([]);
    await academic.releaseSessionCapacityBlock(admin, { classSessionId: id, blockId: input.blockId, reason: "Plaza disponible" });
    expect((await recovery.listFutureRecoveryOptions(student)).sessions).toMatchObject([{ id, availableSpots: 1 }]);
    const { reservationId } = await academic.createReservation(admin, { classSessionId: id, studentProfileId: profileId, origin: "ORDINARY" });
    await academic.cancelReservation(student, { reservationId });
    await expectAvailability(id, 0, 0, 1);
    await credits.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId: profileId, amount: 1, reason: "Crédito de prueba" });
    await recovery.reserveRecovery(student, { classSessionId: id, idempotencyKey: randomUUID() });
    const detail = await expectAvailability(id, 0, 1, 0);
    expect(detail.cancellations).toMatchObject([{ reservationId }]);
    expect(detail.enrollments).toMatchObject([{ origin: "MAKEUP" }]);
    expect((await recovery.listFutureRecoveryOptions(student)).sessions).toEqual([]);
  });

  it("allows audited cleanup of a historical active block without reopening the session", async () => {
    const id = await seedSession();
    const input = request(id);
    await academic.addSessionCapacityBlock(admin, input);
    vi.setSystemTime(new Date("2031-04-10T17:00Z"));
    await academic.releaseSessionCapacityBlock(admin, { classSessionId: id, blockId: input.blockId, reason: "Cierre administrativo" });
    expect((await expectAvailability(id, 0, 0, 0)).capacityBlocks).toMatchObject([{ isActive: false, releaseReason: "Cierre administrativo" }]);
  });

  it("keeps the existing pending-habitual rule and exposes the resulting capacity incidence", async () => {
    const id = await seedSession();
    const templateId = randomUUID();
    await client.query(`insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from)
      values ($1, 'Curso habitual', 4, '17:00', 60, '2031-04-01')`, [templateId]);
    await client.query("update class_sessions set template_id = $1 where id = $2", [templateId, id]);
    await client.query(`insert into student_template_assignments (id, student_profile_id, template_id, effective_from)
      values ($1, $2, $3, '2031-04-01')`, [randomUUID(), profileId, templateId]);
    await academic.addSessionCapacityBlock(admin, request(id));
    expect((await expectAvailability(id, 1, 0, 0)).capacityOverview)
      .toMatchObject({ habitualPending: 1, capacityConflict: true });
  });
});

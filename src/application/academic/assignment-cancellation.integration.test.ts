import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe("future assignment cancellation (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academic: typeof import("@/src/application/academic/academic-service");
  let cancellation: typeof import("@/src/application/academic/assignment-cancellation");
  let withdrawStudent: typeof import("@/src/application/academic/student-withdrawal").withdrawStudent;
  let recovery: typeof import("@/src/application/recovery/recovery-service");
  let creditService: typeof import("@/src/application/credits/credit-service");
  let db: typeof import("@/src/infrastructure/db/client").db;
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("@/src/application/academic/academic-service");
    cancellation = await import("@/src/application/academic/assignment-cancellation");
    ({ withdrawStudent } = await import("@/src/application/academic/student-withdrawal"));
    recovery = await import("@/src/application/recovery/recovery-service");
    creditService = await import("@/src/application/credits/credit-service");
    ({ db } = await import("@/src/infrastructure/db/client"));
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
    await client.query(
      `insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash','SUPER_ADMIN')`,
      [admin.userId, `${admin.userId}@example.com`],
    );
  });

  afterAll(async () => { await client?.end(); });

  const today = () => DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
  const iso = (days: number) => today().plus({ days }).toISODate()!;

  async function seedStudent() {
    const userId = randomUUID();
    const profileId = randomUUID();
    await client.query(
      `insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash','STUDENT')`,
      [userId, `${userId}@example.com`],
    );
    await client.query(
      `insert into student_profiles (id,user_id,first_name,last_name) values ($1,$2,'Test','Student')`,
      [profileId, userId],
    );
    return { userId, profileId };
  }

  async function seedTemplate(effectiveFrom = iso(1), effectiveTo?: string) {
    const templateId = randomUUID();
    await client.query(
      `insert into class_templates (id,name,iso_weekday,starts_at_local_time,duration_minutes,effective_from,effective_to)
       values ($1,'Curso de prueba',1,'18:00',60,$2,$3)`,
      [templateId, effectiveFrom, effectiveTo ?? null],
    );
    return templateId;
  }

  async function seedAssignment(input: {
    studentProfileId: string;
    templateId: string;
    effectiveFrom: string;
    effectiveTo?: string;
  }) {
    const assignmentId = randomUUID();
    await client.query(
      `insert into student_template_assignments (id,student_profile_id,template_id,effective_from,effective_to,status)
       values ($1,$2,$3,$4,$5,$6)`,
      [assignmentId, input.studentProfileId, input.templateId, input.effectiveFrom, input.effectiveTo ?? null,
        input.effectiveTo ? "ENDED" : "ACTIVE"],
    );
    return assignmentId;
  }

  async function seedSession(templateId: string, daysAhead: number) {
    const classSessionId = randomUUID();
    const start = today().plus({ days: daysAhead }).set({ hour: 18 });
    await client.query(
      `insert into class_sessions (id,template_id,local_date,starts_at_utc,ends_at_utc,max_capacity)
       values ($1,$2,$3,$4,$5,12)`,
      [classSessionId, templateId, start.toISODate(), start.toJSDate(), start.plus({ hours: 1 }).toJSDate()],
    );
    return classSessionId;
  }

  async function seedReservation(
    classSessionId: string, studentProfileId: string, origin = "ORDINARY", habitualAssignmentId: string | null = null,
  ) {
    const reservationId = randomUUID();
    await client.query(
      `insert into class_reservations (id,class_session_id,student_profile_id,status,origin,habitual_assignment_id)
       values ($1,$2,$3,'CONFIRMED',$4,$5)`,
      [reservationId, classSessionId, studentProfileId, origin, habitualAssignmentId],
    );
    return reservationId;
  }

  async function seedRecoveryConsumption(reservationId: string, classSessionId: string, profileId: string) {
    const grantId = randomUUID();
    const consumptionId = randomUUID();
    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, reason, source_grant_movement_id, idempotency_key)
       values ($1, $2, 'MANUAL_GRANT', 1, now(), 'seed credit', $1, $3)`,
      [grantId, profileId, `seed-grant:${grantId}`],
    );
    await client.query(
      `insert into credit_ledger_movements
        (id, student_profile_id, movement_type, amount, created_at, reason, class_session_id,
         related_reservation_id, source_grant_movement_id, idempotency_key)
       values ($1, $2, 'RECOVERY_CONSUMPTION', 1, now(), 'seed consumption', $3, $4, $5, $6)`,
      [consumptionId, profileId, classSessionId, reservationId, grantId, `seed-consumption:${consumptionId}`],
    );
    return { grantId, consumptionId };
  }

  async function readLedgerSnapshot(profileId: string) {
    return (await client.query(
      `select id, movement_type, amount, class_session_id, related_reservation_id, source_grant_movement_id,
         idempotency_key, expires_at
       from credit_ledger_movements where student_profile_id=$1 order by id`,
      [profileId],
    )).rows;
  }

  async function readAvailableCredits(profileId: string) {
    const balance = await db.transaction((tx) => creditService.readCreditBalance(tx, profileId));
    return balance.availableCredits;
  }

  async function readConfirmedSeats(classSessionId: string) {
    const { rows: [seat] } = await client.query(
      "select count(*)::int as count from class_reservations where class_session_id=$1 and status='CONFIRMED'",
      [classSessionId],
    );
    return seat.count;
  }

  it("requires SUPER_ADMIN and a valid reason", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate();
    const assignmentId = await seedAssignment({ studentProfileId: student.profileId, templateId, effectiveFrom: iso(2) });

    await expect(cancellation.cancelFutureAssignment(
      { userId: student.userId, role: "STUDENT" },
      { assignmentId, reason: "Anulación solicitada" },
    )).rejects.toMatchObject({ code: "forbidden" });
    await expect(cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "  x  " })).rejects.toThrow();
    await expect(cancellation.cancelFutureAssignment(admin, {
      assignmentId: randomUUID(), reason: "Anulación solicitada",
    })).rejects.toMatchObject({ code: "assignment_not_found" });

    const { rows } = await client.query("select status from student_template_assignments where id=$1", [assignmentId]);
    expect(rows).toEqual([{ status: "ACTIVE" }]);
  });

  it("cancels a future bounded assignment, keeps dates, preserves reservations and audits the decision", async () => {
    const student = await seedStudent();
    const other = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const otherTemplateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const sessionId = await seedSession(templateId, 3);
    const ambiguousReservation = await seedReservation(sessionId, student.profileId);
    const recoveryReservation = await seedReservation(await seedSession(templateId, 4), student.profileId, "MAKEUP");
    const otherReservation = await seedReservation(await seedSession(templateId, 5), other.profileId);
    const otherTemplateReservation = await seedReservation(await seedSession(otherTemplateId, 3), student.profileId);

    const result = await cancellation.cancelFutureAssignment(admin, {
      assignmentId, reason: "El alumno cambia de horario",
    });

    expect(result).toMatchObject({
      assignmentId,
      cancelled: true,
      source: "ADMIN_INDIVIDUAL",
      cancelledReservationIds: [],
      ambiguousReservationIds: [ambiguousReservation],
      requiresAdministrativeReview: 1,
    });

    const { rows: [assignment] } = await client.query(
      "select status,effective_from::text,effective_to::text from student_template_assignments where id=$1",
      [assignmentId],
    );
    expect(assignment).toEqual({ status: "CANCELLED", effective_from: iso(2), effective_to: iso(10) });

    const { rows: audit } = await client.query(
      `select assignment_id,student_profile_id,template_id,source,cancelled_by_user_id,reason,
         effective_from::text,effective_to::text,cancelled_reservation_ids,ambiguous_reservation_ids,regulation_version_id
       from student_template_assignment_cancellations where assignment_id=$1`,
      [assignmentId],
    );
    expect(audit).toEqual([{
      assignment_id: assignmentId,
      student_profile_id: student.profileId,
      template_id: templateId,
      source: "ADMIN_INDIVIDUAL",
      cancelled_by_user_id: admin.userId,
      reason: "El alumno cambia de horario",
      effective_from: iso(2),
      effective_to: iso(10),
      cancelled_reservation_ids: [],
      ambiguous_reservation_ids: [ambiguousReservation],
      regulation_version_id: "initial",
    }]);

    const { rows: reservations } = await client.query(
      "select id,status,cancelled_at from class_reservations where id=any($1::text[]) order by id",
      [[ambiguousReservation, recoveryReservation, otherReservation, otherTemplateReservation]],
    );
    expect(reservations).toHaveLength(4);
    for (const reservation of reservations) expect(reservation).toMatchObject({ status: "CONFIRMED", cancelled_at: null });
    expect((await client.query("select id from reservation_cancellations")).rows).toEqual([]);
    expect((await client.query("select id from credit_ledger_movements")).rows).toEqual([]);

    const schedules = await academic.listStudentHabitualSchedules(
      { userId: student.userId, role: "STUDENT" }, today().toISODate()!,
    );
    expect(schedules).toEqual([]);
    await expect(academic.endStudentTemplateAssignment(admin, { assignmentId }))
      .rejects.toMatchObject({ code: "assignment_cancelled" });
  });

  it("serializes repeated cancellations and returns the original audit", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate();
    const assignmentId = await seedAssignment({ studentProfileId: student.profileId, templateId, effectiveFrom: iso(2) });

    const [first, second] = await Promise.all([
      cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Primera solicitud" }),
      cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Primera solicitud" }),
    ]);
    expect([first.cancelled, second.cancelled].sort()).toEqual([false, true]);
    expect(first.cancellationId).toBe(second.cancellationId);
    expect((await client.query(
      "select id from student_template_assignment_cancellations where assignment_id=$1", [assignmentId],
    )).rows).toHaveLength(1);

    // The retry stays idempotent even when the original start date has already passed.
    await client.query("update student_template_assignments set effective_from=$2 where id=$1", [assignmentId, iso(-1)]);
    const replay = await cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Otra razón" });
    expect(replay).toMatchObject({ cancelled: false, cancellationId: first.cancellationId });
    expect((await client.query(
      "select reason from student_template_assignment_cancellations where assignment_id=$1", [assignmentId],
    )).rows).toEqual([{ reason: "Primera solicitud" }]);
  });

  it("rejects an assignment that already started and leaves finalization available", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(0));
    const assignmentId = await seedAssignment({ studentProfileId: student.profileId, templateId, effectiveFrom: iso(0) });

    await expect(cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Anulación anticipada" }))
      .rejects.toMatchObject({ code: "assignment_already_started" });
    expect((await client.query(
      "select status,effective_to::text from student_template_assignments where id=$1", [assignmentId],
    )).rows).toEqual([{ status: "ACTIVE", effective_to: null }]);
    expect((await client.query("select id from student_template_assignment_cancellations")).rows).toEqual([]);

    await academic.endStudentTemplateAssignment(admin, { assignmentId });
    expect((await client.query(
      "select status,effective_to::text from student_template_assignments where id=$1", [assignmentId],
    )).rows).toEqual([{ status: "ENDED", effective_to: iso(0) }]);
  });

  it("cancels every future assignment on withdrawal without persisting inverted intervals", async () => {
    const student = await seedStudent();
    const firstTemplate = await seedTemplate(iso(1));
    const secondTemplate = await seedTemplate(iso(30));
    const firstAssignment = await seedAssignment({ studentProfileId: student.profileId, templateId: firstTemplate,
      effectiveFrom: iso(1) });
    const secondAssignment = await seedAssignment({ studentProfileId: student.profileId, templateId: secondTemplate,
      effectiveFrom: iso(30), effectiveTo: iso(60) });

    await expect(withdrawStudent(admin, { studentProfileId: student.profileId }))
      .resolves.toEqual({ withdrawn: true, releasedReservations: 0, cancelledRecoveries: 0 });

    const { rows: assignments } = await client.query(
      `select id,status,effective_from::text,effective_to::text from student_template_assignments
       where student_profile_id=$1 order by effective_from`, [student.profileId],
    );
    expect(assignments).toEqual([
      { id: firstAssignment, status: "CANCELLED", effective_from: iso(1), effective_to: null },
      { id: secondAssignment, status: "CANCELLED", effective_from: iso(30), effective_to: iso(60) },
    ]);
    const { rows: audit } = await client.query(
      `select assignment_id,source,reason from student_template_assignment_cancellations
       where student_profile_id=$1 order by effective_from`, [student.profileId],
    );
    expect(audit).toEqual([
      { assignment_id: firstAssignment, source: "STUDENT_WITHDRAWAL", reason: "Baja de la cuenta del alumno" },
      { assignment_id: secondAssignment, source: "STUDENT_WITHDRAWAL", reason: "Baja de la cuenta del alumno" },
    ]);
    expect((await client.query(
      "select ended_assignment_ids from student_withdrawals where student_user_id=$1", [student.userId],
    )).rows).toEqual([{ ended_assignment_ids: [] }]);
    expect((await client.query(
      "select count(*)::int as count from student_template_assignments where effective_to < effective_from",
    )).rows).toEqual([{ count: 0 }]);
  });

  it("does not flag a reservation still supported by another live assignment", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const firstAssignment = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const secondAssignment = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const reservationId = await seedReservation(
      await seedSession(templateId, 3), student.profileId, "ORDINARY", firstAssignment,
    );
    const recoverySessionId = await seedSession(templateId, 9);
    const recoveryReservationId = await seedReservation(
      recoverySessionId, student.profileId, "MAKEUP", firstAssignment,
    );
    await seedRecoveryConsumption(recoveryReservationId, recoverySessionId, student.profileId);
    const ledgerBefore = await readLedgerSnapshot(student.profileId);

    const first = await cancellation.cancelFutureAssignment(admin, {
      assignmentId: firstAssignment, reason: "Primera anulación",
    });
    expect(first.cancelledReservationIds).toEqual([]);
    expect(first.ambiguousReservationIds).toEqual([]);

    const second = await cancellation.cancelFutureAssignment(admin, {
      assignmentId: secondAssignment, reason: "Segunda anulación",
    });
    expect(second.ambiguousReservationIds).toEqual([reservationId]);
    const { rows: kept } = await client.query(
      "select id,status,cancelled_at from class_reservations where id=any($1::text[]) order by id",
      [[reservationId, recoveryReservationId]],
    );
    expect(new Map(kept.map((row) => [row.id, row]))).toEqual(new Map([
      [reservationId, { id: reservationId, status: "CONFIRMED", cancelled_at: null }],
      [recoveryReservationId, { id: recoveryReservationId, status: "CONFIRMED", cancelled_at: null }],
    ]));
    expect(await readLedgerSnapshot(student.profileId)).toEqual(ledgerBefore);
  });

  it("closes an assignment that starts on the withdrawal day with a one-day range", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(0));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(0),
    });

    await expect(withdrawStudent(admin, { studentProfileId: student.profileId }))
      .resolves.toEqual({ withdrawn: true, releasedReservations: 0, cancelledRecoveries: 0 });

    expect((await client.query(
      "select status,effective_from::text,effective_to::text from student_template_assignments where id=$1",
      [assignmentId],
    )).rows).toEqual([{ status: "ENDED", effective_from: iso(0), effective_to: iso(0) }]);
    expect((await client.query(
      "select id from student_template_assignment_cancellations where assignment_id=$1", [assignmentId],
    )).rows).toEqual([]);
  });
  it("cancels only future assigned ordinary reservations and preserves recoveries", async () => {
    const student = await seedStudent();
    const other = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const linked = await seedReservation(await seedSession(templateId, 3), student.profileId, "ORDINARY", assignmentId);
    const linkedMakeupSessionId = await seedSession(templateId, 4);
    const linkedMakeup = await seedReservation(linkedMakeupSessionId, student.profileId, "MAKEUP", assignmentId);
    const unlinkedMakeupSessionId = await seedSession(templateId, 9);
    const unlinkedMakeup = await seedReservation(unlinkedMakeupSessionId, student.profileId, "MAKEUP");
    await seedRecoveryConsumption(linkedMakeup, linkedMakeupSessionId, student.profileId);
    await seedRecoveryConsumption(unlinkedMakeup, unlinkedMakeupSessionId, student.profileId);
    const ledgerBefore = await readLedgerSnapshot(student.profileId);
    const creditsBefore = await readAvailableCredits(student.profileId);
    const seatsBefore = await readConfirmedSeats(linkedMakeupSessionId);
    const unlinked = await seedReservation(await seedSession(templateId, 5), student.profileId);
    const outsideWindow = await seedReservation(
      await seedSession(templateId, 12), student.profileId, "ORDINARY", assignmentId,
    );
    const startedSessionId = await seedSession(templateId, 8);
    await client.query(
      `update class_sessions set starts_at_utc=clock_timestamp()-interval '1 hour',
         ends_at_utc=clock_timestamp() where id=$1`, [startedSessionId],
    );
    const started = await seedReservation(startedSessionId, student.profileId, "ORDINARY", assignmentId);
    const cancelledBefore = await seedReservation(
      await seedSession(templateId, 6), student.profileId, "ORDINARY", assignmentId,
    );
    await client.query(
      "update class_reservations set status='CANCELLED', cancelled_at=now() where id=$1", [cancelledBefore],
    );
    const otherStudent = await seedReservation(
      await seedSession(templateId, 7), other.profileId, "ORDINARY", assignmentId,
    );

    const result = await cancellation.cancelFutureAssignment(admin, {
      assignmentId, reason: "El alumno cambia de horario",
    });

    expect(result.cancelledReservationIds).toEqual([linked]);
    expect(result.ambiguousReservationIds).toEqual([linkedMakeup, unlinked].sort());
    expect(result.requiresAdministrativeReview).toBe(2);

    const { rows: reservations } = await client.query(
      `select id,status,cancelled_at,cancelled_by_user_id,cancellation_regulation_version_id
       from class_reservations
       where id=any($1::text[]) order by id`,
      [[linked, linkedMakeup, unlinkedMakeup, unlinked, outsideWindow, started, cancelledBefore, otherStudent]],
    );
    const byId = new Map(reservations.map((row) => [row.id, row]));
    expect(byId.get(linked)).toMatchObject({
      status: "CANCELLED", cancelled_by_user_id: admin.userId, cancellation_regulation_version_id: "initial",
    });
    expect(byId.get(linked)!.cancelled_at).toBeInstanceOf(Date);
    for (const id of [unlinked, unlinkedMakeup, outsideWindow, started, otherStudent]) {
      expect(byId.get(id)).toMatchObject({ status: "CONFIRMED", cancelled_at: null });
    }
    expect(byId.get(cancelledBefore)).toMatchObject({ status: "CANCELLED", cancelled_by_user_id: null });

    // Recoveries keep their credit consumption and their seats untouched.
    expect(await readLedgerSnapshot(student.profileId)).toEqual(ledgerBefore);
    expect(await readAvailableCredits(student.profileId)).toBe(creditsBefore);
    expect(await readConfirmedSeats(linkedMakeupSessionId)).toBe(seatsBefore);
    expect(await readConfirmedSeats(unlinkedMakeupSessionId)).toBe(1);

    const { rows: audit } = await client.query(
      `select cancelled_reservation_ids,ambiguous_reservation_ids from student_template_assignment_cancellations
       where assignment_id=$1`, [assignmentId],
    );
    expect(audit).toEqual([{
      cancelled_reservation_ids: [linked],
      ambiguous_reservation_ids: [linkedMakeup, unlinked].sort(),
    }]);
    expect((await client.query(
      "select max_capacity from class_sessions where template_id=$1", [templateId],
    )).rows.every(({ max_capacity }) => max_capacity === 12)).toBe(true);
  });

  it("preserves a recovery booked through the legitimate path and its credit consumption", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const classSessionId = await seedSession(templateId, 3);
    await creditService.grantManualCredits(admin, {
      requestId: randomUUID(), studentProfileId: student.profileId, amount: 1, reason: "Crédito de recuperación",
    });
    const booking = await recovery.reserveRecovery(
      { userId: student.userId, role: "STUDENT" }, { classSessionId },
    );
    const ledgerBefore = await readLedgerSnapshot(student.profileId);
    expect(ledgerBefore.map(({ movement_type }) => movement_type).sort())
      .toEqual(["MANUAL_GRANT", "RECOVERY_CONSUMPTION"]);
    expect(await readAvailableCredits(student.profileId)).toBe(0);

    const { rows: [stored] } = await client.query(
      "select origin,status,habitual_assignment_id from class_reservations where id=$1", [booking.reservationId],
    );
    expect(stored).toEqual({ origin: "MAKEUP", status: "CONFIRMED", habitual_assignment_id: null });

    const result = await cancellation.cancelFutureAssignment(admin, {
      assignmentId, reason: "El alumno cambia de horario",
    });

    expect(result).toMatchObject({
      cancelled: true, cancelledReservationIds: [], ambiguousReservationIds: [], requiresAdministrativeReview: 0,
    });
    expect((await client.query(
      "select status,cancelled_at,habitual_assignment_id from class_reservations where id=$1",
      [booking.reservationId],
    )).rows).toEqual([{ status: "CONFIRMED", cancelled_at: null, habitual_assignment_id: null }]);
    expect(await readLedgerSnapshot(student.profileId)).toEqual(ledgerBefore);
    expect(await readAvailableCredits(student.profileId)).toBe(0);
    expect(await readConfirmedSeats(classSessionId)).toBe(1);
    expect((await client.query(
      `select cancelled_reservation_ids,ambiguous_reservation_ids
       from student_template_assignment_cancellations where assignment_id=$1`,
      [assignmentId],
    )).rows).toEqual([{ cancelled_reservation_ids: [], ambiguous_reservation_ids: [] }]);
  });

  it("flags an anomalously linked recovery without cancelling it or touching its credits", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const classSessionId = await seedSession(templateId, 4);
    await creditService.grantManualCredits(admin, {
      requestId: randomUUID(), studentProfileId: student.profileId, amount: 1, reason: "Crédito de recuperación",
    });
    const booking = await recovery.reserveRecovery(
      { userId: student.userId, role: "STUDENT" }, { classSessionId },
    );
    // Synthetic provenance: no production path writes this combination today.
    await client.query(
      "update class_reservations set habitual_assignment_id=$2 where id=$1",
      [booking.reservationId, assignmentId],
    );
    const ledgerBefore = await readLedgerSnapshot(student.profileId);
    const seatsBefore = await readConfirmedSeats(classSessionId);

    const result = await cancellation.cancelFutureAssignment(admin, {
      assignmentId, reason: "El alumno cambia de horario",
    });

    expect(result).toMatchObject({
      cancelled: true,
      cancelledReservationIds: [],
      ambiguousReservationIds: [booking.reservationId],
      requiresAdministrativeReview: 1,
    });
    expect((await client.query(
      "select origin,status,cancelled_at,habitual_assignment_id from class_reservations where id=$1",
      [booking.reservationId],
    )).rows).toEqual([{
      origin: "MAKEUP", status: "CONFIRMED", cancelled_at: null, habitual_assignment_id: assignmentId,
    }]);
    expect(await readLedgerSnapshot(student.profileId)).toEqual(ledgerBefore);
    expect(await readAvailableCredits(student.profileId)).toBe(0);
    expect(await readConfirmedSeats(classSessionId)).toBe(seatsBefore);
    expect((await client.query(
      `select cancelled_reservation_ids,ambiguous_reservation_ids
       from student_template_assignment_cancellations where assignment_id=$1`,
      [assignmentId],
    )).rows).toEqual([{ cancelled_reservation_ids: [], ambiguous_reservation_ids: [booking.reservationId] }]);
    expect((await client.query("select id from reservation_cancellations")).rows).toEqual([]);
  });

  it("is idempotent after releasing linked reservations", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const linked = await seedReservation(await seedSession(templateId, 3), student.profileId, "ORDINARY", assignmentId);

    const first = await cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Anulación inicial" });
    const replay = await cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Otra razón" });

    expect(first).toMatchObject({ cancelled: true, cancelledReservationIds: [linked] });
    expect(replay).toMatchObject({
      cancelled: false, cancellationId: first.cancellationId, cancelledReservationIds: [linked],
    });
    expect((await client.query(
      "select id from student_template_assignment_cancellations where assignment_id=$1", [assignmentId],
    )).rows).toHaveLength(1);
    expect((await client.query(
      "select status from class_reservations where id=$1", [linked],
    )).rows).toEqual([{ status: "CANCELLED" }]);
  });

  it("rolls back the assignment and its linked reservations when the audit cannot be written", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2),
    });
    const linked = await seedReservation(await seedSession(templateId, 3), student.profileId, "ORDINARY", assignmentId);

    await client.query(`create function test_reject_assignment_audit() returns trigger language plpgsql as $$
      begin raise exception 'synthetic audit failure'; end; $$`);
    await client.query(`create trigger test_reject_assignment_audit before insert
      on student_template_assignment_cancellations for each row execute function test_reject_assignment_audit()`);
    try {
      await expect(cancellation.cancelFutureAssignment(admin, {
        assignmentId, reason: "Anulación con fallo de auditoría",
      })).rejects.toMatchObject({ cause: { message: expect.stringContaining("synthetic audit failure") } });
    } finally {
      await client.query("drop trigger test_reject_assignment_audit on student_template_assignment_cancellations");
      await client.query("drop function test_reject_assignment_audit()");
    }

    expect((await client.query(
      "select status from student_template_assignments where id=$1", [assignmentId],
    )).rows).toEqual([{ status: "ACTIVE" }]);
    expect((await client.query(
      "select status,cancelled_at from class_reservations where id=$1", [linked],
    )).rows).toEqual([{ status: "CONFIRMED", cancelled_at: null }]);
    expect((await client.query("select id from student_template_assignment_cancellations")).rows).toEqual([]);
    expect((await client.query("select id from credit_ledger_movements")).rows).toEqual([]);
  });

  it("serializes with session generation without losing linked reservations", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2),
    });

    const [generated] = await Promise.all([
      academic.generateClassSessions(admin, { horizonMonths: 1 }),
      cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Anulación concurrente" }),
    ]);

    expect(generated.inserted).toBeGreaterThan(0);
    expect((await client.query(
      "select status from student_template_assignments where id=$1", [assignmentId],
    )).rows).toEqual([{ status: "CANCELLED" }]);
    expect((await client.query(
      "select status from class_reservations where habitual_assignment_id=$1", [assignmentId],
    )).rows.every(({ status }) => status === "CANCELLED")).toBe(true);
    expect((await client.query(
      "select count(*)::int as count from student_template_assignment_cancellations where assignment_id=$1",
      [assignmentId],
    )).rows).toEqual([{ count: 1 }]);

    // A later generation must not recreate reservations for the cancelled assignment nor duplicate seats.
    await academic.generateClassSessions(admin, { horizonMonths: 1 });
    expect((await client.query(
      `select count(*)::int as count from class_reservations
       where habitual_assignment_id=$1 and status='CONFIRMED'`, [assignmentId],
    )).rows).toEqual([{ count: 0 }]);
    expect((await client.query(
      `select count(*)::int as count from (
         select class_session_id, student_profile_id from class_reservations
         where student_profile_id=$1 and status='CONFIRMED'
         group by 1,2 having count(*) > 1
       ) as duplicates`, [student.profileId],
    )).rows).toEqual([{ count: 0 }]);
  });

  it("serializes with withdrawal without a deadlock or duplicate audit", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const linked = await seedReservation(await seedSession(templateId, 3), student.profileId, "ORDINARY", assignmentId);

    const results = await Promise.allSettled([
      cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Anulación concurrente" }),
      withdrawStudent(admin, { studentProfileId: student.profileId }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).not.toMatchObject({ cause: { code: "40P01" } });
      }
    }

    expect((await client.query(
      "select status from users where id=$1", [student.userId],
    )).rows).toEqual([{ status: "DISABLED" }]);
    expect((await client.query(
      "select status from student_template_assignments where id=$1", [assignmentId],
    )).rows).toEqual([{ status: "CANCELLED" }]);
    expect((await client.query(
      "select status from class_reservations where id=$1", [linked],
    )).rows).toEqual([{ status: "CANCELLED" }]);
    expect((await client.query(
      "select source from student_template_assignment_cancellations where assignment_id=$1", [assignmentId],
    )).rows).toHaveLength(1);
  });

  it("serializes with a concurrent recovery booking without cancelling it", async () => {
    const student = await seedStudent();
    const templateId = await seedTemplate(iso(1), iso(20));
    const assignmentId = await seedAssignment({
      studentProfileId: student.profileId, templateId, effectiveFrom: iso(2), effectiveTo: iso(10),
    });
    const classSessionId = await seedSession(templateId, 3);
    await creditService.grantManualCredits(admin, {
      requestId: randomUUID(), studentProfileId: student.profileId, amount: 1, reason: "Crédito de recuperación",
    });

    const results = await Promise.allSettled([
      cancellation.cancelFutureAssignment(admin, { assignmentId, reason: "Anulación concurrente" }),
      recovery.reserveRecovery({ userId: student.userId, role: "STUDENT" }, { classSessionId }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).not.toMatchObject({ cause: { code: "40P01" } });
    }

    const [cancelled, booked] = results;
    expect(cancelled.status).toBe("fulfilled");
    expect(booked.status).toBe("fulfilled");
    expect((await client.query(
      "select status from student_template_assignments where id=$1", [assignmentId],
    )).rows).toEqual([{ status: "CANCELLED" }]);

    const { rows: reservations } = await client.query(
      "select id,origin,status,habitual_assignment_id from class_reservations where class_session_id=$1",
      [classSessionId],
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      id: booked.status === "fulfilled" ? booked.value.reservationId : null,
      origin: "MAKEUP", status: "CONFIRMED", habitual_assignment_id: null,
    });
    expect(await readAvailableCredits(student.profileId)).toBe(0);
    expect((await client.query(
      "select movement_type from credit_ledger_movements where student_profile_id=$1 order by movement_type",
      [student.profileId],
    )).rows.map(({ movement_type }) => movement_type)).toEqual(["MANUAL_GRANT", "RECOVERY_CONSUMPTION"]);
    expect((await client.query(
      "select cancelled_reservation_ids,ambiguous_reservation_ids from student_template_assignment_cancellations where assignment_id=$1",
      [assignmentId],
    )).rows).toEqual([{ cancelled_reservation_ids: [], ambiguous_reservation_ids: [] }]);
  });
});

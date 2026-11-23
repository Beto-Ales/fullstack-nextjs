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
  const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academic = await import("@/src/application/academic/academic-service");
    cancellation = await import("@/src/application/academic/assignment-cancellation");
    ({ withdrawStudent } = await import("@/src/application/academic/student-withdrawal"));
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

  async function seedReservation(classSessionId: string, studentProfileId: string, origin = "ORDINARY") {
    const reservationId = randomUUID();
    await client.query(
      `insert into class_reservations (id,class_session_id,student_profile_id,status,origin)
       values ($1,$2,$3,'CONFIRMED',$4)`,
      [reservationId, classSessionId, studentProfileId, origin],
    );
    return reservationId;
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
    const reservationId = await seedReservation(await seedSession(templateId, 3), student.profileId);

    const first = await cancellation.cancelFutureAssignment(admin, {
      assignmentId: firstAssignment, reason: "Primera anulación",
    });
    expect(first.ambiguousReservationIds).toEqual([]);

    const second = await cancellation.cancelFutureAssignment(admin, {
      assignmentId: secondAssignment, reason: "Segunda anulación",
    });
    expect(second.ambiguousReservationIds).toEqual([reservationId]);
    expect((await client.query(
      "select status,cancelled_at from class_reservations where id=$1", [reservationId],
    )).rows).toEqual([{ status: "CONFIRMED", cancelled_at: null }]);
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
});

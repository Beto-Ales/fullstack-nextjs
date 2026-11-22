import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("academic integration (postgres)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let academicService: typeof import("@/src/application/academic/academic-service");

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    academicService = await import("@/src/application/academic/academic-service");
  });

  beforeEach(async () => {
    await resetTestDatabase(client);
  });

  afterEach(() => vi.useRealTimers());

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  async function seedTemplateAndSession(localDate: string, startsAtUtcIso: string, endsAtUtcIso: string) {
    const templateId = randomUUID();
    const sessionId = randomUUID();

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
        ($1, $2, $3, $4, $5, 'SCHEDULED', 12, false, now(), now())`,
      [sessionId, templateId, localDate, startsAtUtcIso, endsAtUtcIso],
    );

    return { templateId, sessionId };
  }

  async function seedStudentProfiles(count: number) {
    const students = Array.from({ length: count }, () => ({ userId: randomUUID(), profileId: randomUUID() }));
    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role)
       select id, id || '@example.com', id || '@example.com', 'hash', 'STUDENT'
       from unnest($1::text[]) as student(id)`,
      [students.map((student) => student.userId)],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name)
       select profile_id, user_id, 'Test', 'Student'
       from unnest($1::text[], $2::text[]) as student(profile_id, user_id)`,
      [students.map((student) => student.profileId), students.map((student) => student.userId)],
    );
    return students;
  }

  it("withdraws once, frees future ordinary and recovery seats, and refunds only the eligible recovery", async () => {
    const today = DateTime.now().setZone(CENTER_TIME_ZONE).startOf("day");
    vi.setSystemTime(today.set({ hour: 12 }).toJSDate());
    const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };
    const [departing, remaining, substitute, recovering] = await seedStudentProfiles(4);
    const student = { userId: departing.userId, role: "STUDENT" as const };
    await client.query("insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash','SUPER_ADMIN')",
      [admin.userId, `${admin.userId}@example.com`]);
    const auth = await import("@/src/application/auth/auth-service");
    const password = randomUUID();
    const { hashPassword } = await import("@/src/infrastructure/security/password");
    await client.query("update users set password_hash=$1 where id=$2", [await hashPassword(password), departing.userId]);
    const credentials = { email: `${departing.userId}@example.com`, password, sourceKey: randomUUID() };
    const login = await auth.authenticateUser(credentials);
    expect(await auth.getAuthenticatedUserFromSessionToken(login.sessionToken)).toBeTruthy();

    const past = today.minus({ weeks: 1 });
    const { templateId } = await academicService.createClassTemplate(admin, {
      name: "Withdrawal course", isoWeekday: today.weekday, startsAtLocalTime: "18:00", durationMinutes: 60,
      effectiveFrom: past.toISODate(), effectiveTo: today.plus({ weeks: 2 }).toISODate(),
    });
    const { assignmentId } = await academicService.assignStudentToTemplate(admin, {
      templateId, studentProfileId: departing.profileId, effectiveFrom: past.toISODate(),
    });
    const scheduledAssignment = await academicService.assignStudentToTemplate(admin, {
      templateId, studentProfileId: departing.profileId, effectiveFrom: today.plus({ weeks: 1 }).toISODate(),
      effectiveTo: today.plus({ weeks: 2 }).toISODate(),
    });
    const completedCourse = await academicService.createClassTemplate(admin, {
      name: "Completed course", isoWeekday: today.weekday, startsAtLocalTime: "18:00", durationMinutes: 60,
      effectiveFrom: past.toISODate(), effectiveTo: past.toISODate(),
    });
    const completedCourseAssignment = await academicService.assignStudentToTemplate(admin, {
      templateId: completedCourse.templateId, studentProfileId: departing.profileId, effectiveFrom: past.toISODate(),
    });
    const otherEnrollees = [remaining, ...await seedStudentProfiles(10)];
    for (const { profileId } of otherEnrollees) {
      await academicService.assignStudentToTemplate(admin, {
        templateId, studentProfileId: profileId, effectiveFrom: today.toISODate(),
      });
    }
    const enrollSubstitute = () => academicService.enrollStudentInAcademicOffering(admin, {
      targetType: "weekly", targetId: templateId, studentProfileId: substitute.profileId,
    });
    await expect(enrollSubstitute()).rejects.toMatchObject({ code: "course_enrollment_full" });

    const dates = [past, today, today.plus({ weeks: 1 }), today.plus({ weeks: 2 })];
    const sessionIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const reservationIds = sessionIds.map(() => randomUUID());
    for (const [index, day] of dates.entries()) {
      const start = day.set({ hour: 18 });
      await client.query(
        `insert into class_sessions (id,template_id,local_date,starts_at_utc,ends_at_utc,max_capacity)
         values ($1,$2,$3,$4,$5,$6)`,
        [sessionIds[index], templateId, day.toISODate(), start.toJSDate(), start.plus({ hours: 1 }).toJSDate(), [1, 3, 2, 1][index]],
      );
      await client.query(
        "insert into class_reservations (id,class_session_id,student_profile_id,regulation_version_id) values ($1,$2,$3,'initial')",
        [reservationIds[index], sessionIds[index], departing.profileId],
      );
    }
    const otherReservation = await academicService.createReservation(admin, {
      classSessionId: sessionIds[1], studentProfileId: remaining.profileId,
    });
    for (const classSessionId of sessionIds.slice(1, 3)) {
      await academicService.addSessionCapacityBlock(admin, { classSessionId, blockId: randomUUID(), blockedSpots: 1, reason: "Bloqueo de prueba" });
      expect(await academicService.getClassSessionAvailability(classSessionId)).toMatchObject({ availableSpots: 0 });
    }
    const credit = await import("@/src/application/credits/credit-service");
    const recovery = await import("@/src/application/recovery/recovery-service");
    await credit.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId: departing.profileId, amount: 2, reason: "Withdrawal fixture" });
    async function reserveMakeup(daysAhead: number) {
      const { classSessionId } = await academicService.createOneOffClassSession(admin, {
        localDate: today.plus({ days: daysAhead }).toISODate(), startsAtLocalTime: "18:00", durationMinutes: 60, maxCapacity: 1,
      });
      const booking = await recovery.reserveRecovery(student, { classSessionId });
      expect(await academicService.getClassSessionAvailability(classSessionId)).toMatchObject({ availableSpots: 0 });
      return { ...booking, classSessionId };
    }
    const onTime = await reserveMakeup(9);
    const late = await reserveMakeup(3);
    const readLedger = async () => (await client.query(
      `select id,movement_type,amount,related_reservation_id,source_movement_id,source_grant_movement_id,refund_restored_credit,
       regulation_version_id from credit_ledger_movements where student_profile_id=$1 order by id`, [departing.profileId],
    )).rows;
    const originalLedger = await readLedger();
    expect(originalLedger.map(({ movement_type }) => movement_type)).toContain("RECOVERY_CONSUMPTION");

    const { withdrawStudent } = await import("@/src/application/academic/student-withdrawal");
    await expect(withdrawStudent(student, { studentProfileId: departing.profileId })).rejects.toMatchObject({ code: "forbidden" });
    const attempts = await Promise.all([
      withdrawStudent(admin, { studentProfileId: departing.profileId }),
      withdrawStudent(admin, { studentProfileId: departing.profileId }),
    ]);
    expect(attempts).toContainEqual({ withdrawn: true, releasedReservations: 3, cancelledRecoveries: 2 });
    expect(attempts).toContainEqual({ withdrawn: false, releasedReservations: 0, cancelledRecoveries: 0 });
    const { rows: [account] } = await client.query("select status,deactivated_at from users where id=$1", [departing.userId]);
    expect(account).toEqual({ status: "DISABLED", deactivated_at: new Date() });
    const { rows: activeSessions } = await client.query("select id from sessions where user_id=$1", [departing.userId]);
    expect(activeSessions).toHaveLength(0);
    expect(await auth.getAuthenticatedUserFromSessionToken(login.sessionToken)).toBeNull();
    await expect(auth.authenticateUser(credentials)).rejects.toMatchObject({ code: "invalid_credentials" });
    const { rows: assignments } = await client.query(
      "select status,effective_to::text from student_template_assignments where student_profile_id=$1 and template_id=$2",
      [departing.profileId, templateId],
    );
    expect(assignments).toEqual(Array.from({ length: 2 }, () => ({ status: "ENDED", effective_to: today.toISODate() })));
    const { rows: history } = await client.query(
      "select status,effective_to from student_template_assignments where id=$1", [completedCourseAssignment.assignmentId],
    );
    expect(history).toEqual([{ status: "ACTIVE", effective_to: null }]);
    const readAudit = async () => (await client.query(
      "select * from student_withdrawals where student_user_id=$1", [departing.userId],
    )).rows;
    const audit = await readAudit();
    expect(audit).toEqual([{
      student_user_id: departing.userId, withdrawn_by_user_id: admin.userId, withdrawn_at: account.deactivated_at,
      ended_assignment_ids: expect.arrayContaining([assignmentId, scheduledAssignment.assignmentId]),
      released_reservation_ids: expect.arrayContaining(reservationIds.slice(1)),
      cancelled_recoveries: expect.arrayContaining([
        { reservationId: onTime.reservationId, refunded: true, refundRestoredCredit: true },
        { reservationId: late.reservationId, refunded: false, refundRestoredCredit: false },
      ]),
    }]);
    const { rows: bookings } = await client.query(
      "select id,status,cancelled_at from class_reservations where id=any($1::text[])",
      [[...reservationIds, onTime.reservationId, late.reservationId, otherReservation.reservationId]],
    );
    expect(bookings).toHaveLength(7);
    for (const id of [reservationIds[0], otherReservation.reservationId]) {
      expect(bookings).toContainEqual({ id, status: "CONFIRMED", cancelled_at: null });
    }
    for (const id of [...reservationIds.slice(1), onTime.reservationId, late.reservationId]) {
      expect(bookings).toContainEqual({ id, status: "CANCELLED", cancelled_at: account.deactivated_at });
    }
    const finalLedger = await readLedger();
    expect(finalLedger.filter(({ movement_type }) => movement_type !== "RECOVERY_REFUND")).toEqual(originalLedger);
    expect(finalLedger.filter(({ movement_type }) => movement_type === "RECOVERY_REFUND")).toEqual([{
      id: expect.any(String), movement_type: "RECOVERY_REFUND", amount: 1, related_reservation_id: onTime.reservationId,
      source_movement_id: onTime.consumedMovementId, source_grant_movement_id: onTime.consumedFromGrantMovementId,
      refund_restored_credit: true, regulation_version_id: "initial",
    }]);
    for (const classSessionId of [onTime.classSessionId, late.classSessionId]) {
      expect(await academicService.getClassSessionAvailability(classSessionId)).toMatchObject({ availableSpots: 1 });
    }
    await expect(academicService.enrollStudentInAcademicOffering(admin, {
      targetType: "weekly", targetId: templateId, studentProfileId: departing.profileId,
    })).rejects.toMatchObject({ code: "student_inactive" });

    await credit.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId: recovering.profileId, amount: 1, reason: "Replacement recovery" });
    const filled = await recovery.reserveRecovery({ userId: recovering.userId, role: "STUDENT" }, { classSessionId: sessionIds[1] });
    expect(filled.consumedMovementId).toBeTruthy();
    expect(await enrollSubstitute()).toEqual({ reservedSessions: 2 });
    vi.setSystemTime(today.plus({ days: 1 }).toJSDate());
    expect(await withdrawStudent(admin, { studentProfileId: departing.profileId }))
      .toEqual({ withdrawn: false, releasedReservations: 0, cancelledRecoveries: 0 });
    expect(await readAudit()).toEqual(audit);
    expect(await readLedger()).toEqual(finalLedger);
    const { rows: replacementBookings } = await client.query(
      "select class_session_id from class_reservations where student_profile_id=$1 and status='CONFIRMED'", [substitute.profileId],
    );
    expect(replacementBookings.map(({ class_session_id }) => class_session_id).sort()).toEqual(sessionIds.slice(2).sort());
    expect(await academicService.getClassSessionAvailability(sessionIds[1]))
      .toMatchObject({ confirmedReservations: 2, blockedSpots: 1, availableSpots: 0 });
    expect(await academicService.getClassSessionAvailability(sessionIds[2]))
      .toMatchObject({ confirmedReservations: 1, blockedSpots: 1, availableSpots: 0 });
  });

  it("creates a one-off session through the admin service and rejects the thirteenth seat under concurrency", async () => {
    const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };
    const students = await seedStudentProfiles(13);
    const date = DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 9 });
    const payload = { localDate: date.toISODate(), startsAtLocalTime: "18:00", durationMinutes: 60 };
    await expect(academicService.createOneOffClassSession({ ...students[0], role: "STUDENT" }, payload))
      .rejects.toMatchObject({ code: "forbidden" });
    const { classSessionId } = await academicService.createOneOffClassSession(admin, payload);
    const { rows } = await client.query("select template_id, local_date::text, max_capacity from class_sessions where id=$1", [classSessionId]);
    expect(rows).toEqual([{ template_id: null, local_date: payload.localDate, max_capacity: 12 }]);

    const book = (student: { profileId: string }) => academicService.enrollStudentInAcademicOffering(
      admin, { targetType: "one-off", targetId: classSessionId, studentProfileId: student.profileId },
    );
    await Promise.all(students.slice(0, 11).map(book));
    const lastSeat = await Promise.allSettled(students.slice(11).map(book));
    expect(lastSeat.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(lastSeat).toContainEqual(expect.objectContaining({
      status: "rejected", reason: expect.objectContaining({ code: "no_spots_available" }),
    }));
    expect(await academicService.getClassSessionAvailability(classSessionId))
      .toMatchObject({ capacity: 12, confirmedReservations: 12, availableSpots: 0 });
  });

  it("keeps a fixed course within its dates when the periodic generator uses a longer horizon", async () => {
    const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };
    const first = DateTime.now().setZone(CENTER_TIME_ZONE).plus({ months: 4 }).endOf("month").startOf("day");
    const end = first.plus({ months: 3 });
    const { templateId, insertedSessions } = await academicService.createWeeklyCourse(admin, {
      name: "Fixed weekly course", firstClassDate: first.toISODate(), startsAtLocalTime: "18:00", durationMinutes: 60,
    });
    expect(insertedSessions).toBeGreaterThan(0);
    expect(await academicService.generateClassSessions(admin, { horizonMonths: 12 }))
      .toMatchObject({ inserted: 0, skipped: insertedSessions });
    const { rows } = await client.query("select local_date::text from class_sessions where template_id=$1 order by local_date", [templateId]);
    const dates = [];
    for (let day = first; day < end; day = day.plus({ weeks: 1 })) dates.push({ local_date: day.toISODate() });
    expect(rows).toEqual(dates);
  });

  it("rejects a course enrollment that would exceed capacity only after another enrollment starts", async () => {
    const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };
    const students = await seedStudentProfiles(13);
    const first = DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 7 });
    const later = first.plus({ weeks: 2 });
    const { templateId } = await academicService.createClassTemplate(admin, {
      name: "Future enrollment overlap", isoWeekday: first.weekday, startsAtLocalTime: "18:00", durationMinutes: 60,
      effectiveFrom: first.toISODate(), effectiveTo: later.plus({ weeks: 2 }).toISODate(),
    });
    await Promise.all(students.slice(0, 12).map(({ profileId }, index) =>
      academicService.assignStudentToTemplate(admin, {
        templateId, studentProfileId: profileId, effectiveFrom: index === 11 ? later.toISODate() : first.toISODate(),
      }),
    ));
    await expect(academicService.assignStudentToTemplate(admin, {
      templateId, studentProfileId: students[12].profileId, effectiveFrom: first.toISODate(),
    })).rejects.toMatchObject({ code: "course_enrollment_full" });
  });

  it("rejects the thirteenth simultaneous course enrollment and lets a recovery fill a cancelled seat for one date", async () => {
    const admin = { userId: randomUUID(), role: "SUPER_ADMIN" as const };
    const students = await seedStudentProfiles(14);
    await client.query("insert into users (id,email,email_normalized,password_hash,role) values ($1,$2,$2,'hash','SUPER_ADMIN')",
      [admin.userId, `${admin.userId}@example.com`]);
    const first = DateTime.now().setZone(CENTER_TIME_ZONE).plus({ days: 9 });
    const second = first.plus({ weeks: 1 });
    const effectiveFrom = first.toISODate()!;
    const { templateId } = await academicService.createClassTemplate(admin, {
      name: "Weekly course", isoWeekday: first.weekday, startsAtLocalTime: "18:00", durationMinutes: 60,
      effectiveFrom, effectiveTo: second.toISODate(),
    });
    expect(await academicService.generateClassSessions(admin, {})).toMatchObject({ inserted: 2 });
    const assignments = await Promise.allSettled(students.slice(0, 13).map(({ profileId }) =>
      academicService.enrollStudentInAcademicOffering(admin, {
        targetType: "weekly", targetId: templateId, studentProfileId: profileId,
      }),
    ));
    expect(assignments.filter(({ status }) => status === "fulfilled")).toHaveLength(12);
    expect(assignments.filter(({ status }) => status === "rejected")).toEqual([expect.objectContaining({
      reason: expect.objectContaining({ code: "course_enrollment_full" }),
    })]);
    const enrollmentCount = async () => {
      const { rows: [{ count }] } = await client.query("select count(*)::int as count from student_template_assignments where template_id=$1", [templateId]);
      return count;
    };
    expect(await enrollmentCount()).toBe(12);

    const { rows: [firstSession, secondSession] } = await client.query(
      "select id from class_sessions where template_id=$1 order by local_date", [templateId],
    );
    const { rows: [booking] } = await client.query(
      `select r.id, p.user_id from class_reservations r join student_profiles p on p.id=r.student_profile_id
       where r.class_session_id=$1 and r.status='CONFIRMED' limit 1`, [firstSession.id],
    );
    await academicService.cancelReservation({ userId: booking.user_id, role: "STUDENT" }, { reservationId: booking.id });
    expect(await academicService.getClassSessionAvailability(firstSession.id))
      .toMatchObject({ confirmedReservations: 11, availableSpots: 1 });
    expect(await academicService.getClassSessionAvailability(secondSession.id))
      .toMatchObject({ confirmedReservations: 12, availableSpots: 0 });
    expect(await enrollmentCount()).toBe(12);

    const recovering = students[13];
    const creditService = await import("@/src/application/credits/credit-service");
    const recoveryService = await import("@/src/application/recovery/recovery-service");
    await creditService.grantManualCredits(admin, { requestId: randomUUID(), studentProfileId: recovering.profileId, amount: 1, reason: "Recovery eligibility fixture" });
    const recoveringActor = { userId: recovering.userId, role: "STUDENT" as const };
    const reserved = await recoveryService.reserveRecovery(recoveringActor, { classSessionId: firstSession.id });
    expect(reserved.consumedMovementId).toBeTruthy();
    expect(await academicService.getClassSessionAvailability(firstSession.id))
      .toMatchObject({ confirmedReservations: 12, availableSpots: 0 });
    expect(await academicService.getClassSessionAvailability(secondSession.id))
      .toMatchObject({ confirmedReservations: 12, availableSpots: 0 });
    expect(await enrollmentCount()).toBe(12);
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

  it("detects absences without relying on database UUID extensions", async () => {
    const adminUserId = randomUUID();
    const studentUserId = randomUUID();
    const profileId = randomUUID();
    const templateId = randomUUID();
    const sessionId = randomUUID();
    const reservationId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values
       ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now()),
       ($4, $5, $6, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [
        adminUserId,
        `${adminUserId}@example.com`,
        `${adminUserId}@example.com`,
        studentUserId,
        `${studentUserId}@example.com`,
        `${studentUserId}@example.com`,
      ],
    );

    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Absent', 'Student', now(), now())`,
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
        ($1, $2, '2026-01-06', '2026-01-06T17:00:00Z', '2026-01-06T18:00:00Z', 'COMPLETED', 12, false, now(), now())`,
      [sessionId, templateId],
    );

    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
        ($1, $2, $3, 'CONFIRMED', 'ORDINARY', now(), now())`,
      [reservationId, sessionId, profileId],
    );

    const result = await academicService.detectAbsences(
      { userId: adminUserId, role: "SUPER_ADMIN" },
      { referenceTimeUtc: new Date("2026-01-07T00:00:00.000Z") },
    );

    expect(result.createdAbsences).toBe(1);

    const rows = await client.query<{ id: string; source: string }>(
      `select id, source
       from reservation_attendance_records
       where reservation_id = $1`,
      [reservationId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.id).toHaveLength(36);
    expect(rows.rows[0]?.source).toBe("AUTO");
  });

  it("reprograms a session across months and updates local_date for monthly accounting", async () => {
    const adminUserId = randomUUID();
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values
       ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now()),
       ($4, $5, $6, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [
        adminUserId,
        `${adminUserId}@example.com`,
        `${adminUserId}@example.com`,
        studentUserId,
        `${studentUserId}@example.com`,
        `${studentUserId}@example.com`,
      ],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Reprogram', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    const originalDate = "2026-01-10";
    const movedDate = "2026-02-10";
    const session = await seedTemplateAndSession(originalDate, "2026-01-10T17:00:00.000Z", "2026-01-10T18:00:00.000Z");

    await client.query(
      `insert into class_reservations (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values ($1, $2, $3, 'CONFIRMED', 'MAKEUP', now(), now())`,
      [randomUUID(), session.sessionId, studentProfileId],
    );

    const movedStart = DateTime.fromISO(`${movedDate}T18:00:00`, { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();
    const movedEnd = DateTime.fromISO(`${movedDate}T19:00:00`, { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();

    await academicService.updateClassSession(
      { userId: adminUserId, role: "SUPER_ADMIN" },
      { classSessionId: session.sessionId, startsAtUtc: movedStart, endsAtUtc: movedEnd },
    );

    const moved = await client.query<{ local_date: string }>(`select local_date::text from class_sessions where id = $1`, [session.sessionId]);
    expect(moved.rows[0]?.local_date).toBe(movedDate);
    const edit = await client.query("select regulation_version_id from class_session_edits where class_session_id = $1", [session.sessionId]);
    expect(edit.rows).toEqual([{ regulation_version_id: "initial" }]);
  });

  it("rejects reprogramming that would exceed monthly recovery limit after month change", async () => {
    const adminUserId = randomUUID();
    const studentUserId = randomUUID();
    const studentProfileId = randomUUID();

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values
       ($1, $2, $3, 'hash', 'SUPER_ADMIN', 'ACTIVE', now(), now()),
       ($4, $5, $6, 'hash', 'STUDENT', 'ACTIVE', now(), now())`,
      [
        adminUserId,
        `${adminUserId}@example.com`,
        `${adminUserId}@example.com`,
        studentUserId,
        `${studentUserId}@example.com`,
        `${studentUserId}@example.com`,
      ],
    );
    await client.query(
      `insert into student_profiles (id, user_id, first_name, last_name, created_at, updated_at)
       values ($1, $2, 'Limit', 'Student', now(), now())`,
      [studentProfileId, studentUserId],
    );

    const movable = await seedTemplateAndSession("2026-01-10", "2026-01-10T17:00:00.000Z", "2026-01-10T18:00:00.000Z");
    const monthTargetA = await seedTemplateAndSession("2026-02-03", "2026-02-03T17:00:00.000Z", "2026-02-03T18:00:00.000Z");
    const monthTargetB = await seedTemplateAndSession("2026-02-17", "2026-02-17T17:00:00.000Z", "2026-02-17T18:00:00.000Z");

    await client.query(
      `insert into class_reservations (id, class_session_id, student_profile_id, status, origin, created_at, updated_at)
       values
       ($1, $2, $4, 'CONFIRMED', 'MAKEUP', now(), now()),
       ($3, $5, $4, 'CONFIRMED', 'MAKEUP', now(), now()),
       ($6, $7, $4, 'CONFIRMED', 'MAKEUP', now(), now())`,
      [
        randomUUID(),
        movable.sessionId,
        randomUUID(),
        studentProfileId,
        monthTargetA.sessionId,
        randomUUID(),
        monthTargetB.sessionId,
      ],
    );

    const movedStart = DateTime.fromISO("2026-02-10T18:00:00", { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();
    const movedEnd = DateTime.fromISO("2026-02-10T19:00:00", { zone: CENTER_TIME_ZONE }).toUTC().toJSDate();

    await expect(
      academicService.updateClassSession(
        { userId: adminUserId, role: "SUPER_ADMIN" },
        { classSessionId: movable.sessionId, startsAtUtc: movedStart, endsAtUtc: movedEnd },
      ),
    ).rejects.toMatchObject({ code: "reprogram_monthly_recovery_limit_conflict" });
  });
});

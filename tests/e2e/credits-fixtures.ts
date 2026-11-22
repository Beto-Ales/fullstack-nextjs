import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { DateTime } from "luxon";
import type { Client } from "pg";

import { BCRYPT_COST } from "../../src/domain/auth/password-policy";
import { CENTER_TIME_ZONE } from "../../src/domain/time/timezone";
import { createVerifiedTestClient } from "../../src/test-support/postgres-test-db";

export async function withCreditsAccount<T>(
  role: "STUDENT" | "SUPER_ADMIN",
  run: (fixture: { client: Client; userId: string; email: string; password: string; sessionIds: string[]; templateIds: string[] }) => Promise<T>,
) {
  const client = await createVerifiedTestClient();
  const userId = randomUUID();
  const email = `e2e-${userId}@example.com`;
  const password = randomUUID();
  const sessionIds: string[] = [];
  const templateIds: string[] = [];
  try {
    await client.query(
      "insert into users (id, email, email_normalized, password_hash, role) values ($1, $2, $2, $3, $4)",
      [userId, email, await bcrypt.hash(password, BCRYPT_COST), role],
    );
    return await run({ client, userId, email, password, sessionIds, templateIds });
  } finally {
    try {
      await client.query("delete from class_sessions where id = any($1::text[])", [sessionIds]);
      await client.query("delete from class_templates where id = any($1::text[])", [templateIds]);
      await client.query("delete from users where id = $1", [userId]);
    } finally {
      await client.end();
    }
  }
}

export async function seedHabitualCreditScenario(
  fixture: { client: Client; userId: string; sessionIds: string[]; templateIds: string[] },
) {
  const { client, userId, sessionIds, templateIds } = fixture;
  const now = DateTime.now().setZone(CENTER_TIME_ZONE);
  const { rows: [regulation] } = await client.query<{ id: string; cancellation_notice_days: number }>(
    "select id, cancellation_notice_days from academic_regulations where effective_from <= $1 order by effective_from desc limit 1",
    [now.toISODate()],
  );
  if (!regulation) throw new Error("The TEST database requires the academic regulation migration.");

  const profileId = randomUUID();
  const templateId = randomUUID();
  templateIds.push(templateId);
  const firstDate = now.startOf("day").plus({ days: regulation.cancellation_notice_days + 2 }).set({ hour: 18 });
  const habitualDates = [firstDate, firstDate.plus({ weeks: 1 }), firstDate.plus({ weeks: 2 })];
  const recoveryDate = habitualDates[2].plus({ days: 1 });

  await client.query(
    "insert into student_profiles (id, user_id, first_name, last_name) values ($1, $2, 'E2E', 'Student')",
    [profileId, userId],
  );
  await client.query(
    `insert into class_templates
      (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from, max_capacity, regulation_version_id)
      values ($1, 'E2E habitual class', $2, '18:00', 60, $3, 1, $4)`,
    [templateId, firstDate.weekday, firstDate.toISODate(), regulation.id],
  );
  await client.query(
    "insert into student_template_assignments (id, student_profile_id, template_id, effective_from) values ($1, $2, $3, $4)",
    [randomUUID(), profileId, templateId, firstDate.toISODate()],
  );

  async function createSession(start: DateTime, template: string | null) {
    const id = randomUUID();
    sessionIds.push(id);
    await client.query(
      `insert into class_sessions
        (id, template_id, local_date, starts_at_utc, ends_at_utc, max_capacity, regulation_version_id)
        values ($1, $2, $3, $4, $5, 1, $6)`,
      [id, template, start.toISODate(), start.toJSDate(), start.plus({ hours: 1 }).toJSDate(), regulation.id],
    );
    return id;
  }

  const habitualSessionId = await createSession(habitualDates[2], templateId);
  const habitualReservationId = randomUUID();
  await client.query(
    "insert into class_reservations (id, class_session_id, student_profile_id, regulation_version_id) values ($1, $2, $3, $4)",
    [habitualReservationId, habitualSessionId, profileId, regulation.id],
  );

  // Seed the first two recorded cancellations without grants so the target starts in third position.
  const cancelledAt = now.minus({ days: 1 });
  for (const [index, start] of habitualDates.slice(0, 2).entries()) {
    const sessionId = await createSession(start, templateId);
    const reservationId = randomUUID();
    await client.query(
      `insert into class_reservations
        (id, class_session_id, student_profile_id, status, cancelled_at, cancelled_by_user_id,
         regulation_version_id, cancellation_regulation_version_id)
        values ($1, $2, $3, 'CANCELLED', $4, $5, $6, $6)`,
      [reservationId, sessionId, profileId, cancelledAt.toJSDate(), userId, regulation.id],
    );
    await client.query(
      `insert into reservation_cancellations
        (id, reservation_id, student_profile_id, class_session_id, cancelled_by_user_id, cancelled_at,
         regulation_version_id, cancellation_type, hours_before_start, meets_seven_day_rule,
         is_habitual_reservation, sequence_id, sequence_position, non_eligibility_reason)
        values ($1, $2, $3, $4, $5, $6, $7, 'ON_TIME', $8, true, true, 'seq-1', $9, 'SEQUENCE_POSITION')`,
      [randomUUID(), reservationId, profileId, sessionId, userId, cancelledAt.toJSDate(),
        regulation.id, Math.floor(start.diff(cancelledAt, "hours").hours), index + 1],
    );
  }

  const recoverySessionId = await createSession(recoveryDate, null);
  return { profileId, habitualSessionId, habitualReservationId, recoverySessionId, regulationVersionId: regulation.id,
    habitualDate: habitualDates[2].toISODate()!, recoveryDate: recoveryDate.toISODate()! };
}

export async function seedRecoveryCapacityScenario(
  fixture: { client: Client; sessionIds: string[] },
  studentUserIds: [string, string],
  occupiedUserId: string,
) {
  const { client, sessionIds } = fixture;
  const now = DateTime.now().setZone(CENTER_TIME_ZONE);
  const { rows: [regulation] } = await client.query<{ id: string }>(
    "select id from academic_regulations where effective_from <= $1 order by effective_from desc limit 1",
    [now.toISODate()],
  );
  if (!regulation) throw new Error("The TEST database requires the academic regulation migration.");

  const profiles = [randomUUID(), randomUUID()];
  const occupiedProfile = randomUUID();
  await client.query(
    `insert into student_profiles (id, user_id, first_name, last_name)
     select profile_id, user_id, 'E2E', 'Recovery'
     from unnest($1::text[], $2::text[]) as student(profile_id, user_id)`,
    [[...profiles, occupiedProfile], [...studentUserIds, occupiedUserId]],
  );
  const grantIds = [randomUUID(), randomUUID()];
  await client.query(
    `insert into credit_ledger_movements
       (id, student_profile_id, movement_type, amount, expires_at, source_grant_movement_id, idempotency_key, regulation_version_id)
     select grant_id, profile_id, 'MANUAL_GRANT', 1, $3, grant_id, 'e2e-grant:' || grant_id, $4
     from unnest($1::text[], $2::text[]) as credit(grant_id, profile_id)`,
    [grantIds, profiles, now.plus({ months: 2 }).toJSDate(), regulation.id],
  );

  async function createSession(daysAhead: number) {
    const start = now.plus({ days: daysAhead }).startOf("day").set({ hour: 14, minute: 25 });
    const id = randomUUID();
    sessionIds.push(id);
    await client.query(
      `insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity, regulation_version_id)
       values ($1, $2, $3, $4, 1, $5)`,
      [id, start.toISODate(), start.toJSDate(), start.plus({ hours: 1 }).toJSDate(), regulation.id],
    );
    return { id, timestamp: start.toJSDate().toISOString() };
  }

  const full = await createSession(20);
  const blocked = await createSession(21);
  const contested = await createSession(22);
  await client.query(
    "insert into class_reservations (id, class_session_id, student_profile_id, regulation_version_id) values ($1, $2, $3, $4)",
    [randomUUID(), full.id, occupiedProfile, regulation.id],
  );
  await client.query(
    "insert into session_capacity_blocks (id, class_session_id, blocked_spots, regulation_version_id) values ($1, $2, 1, $3)",
    [randomUUID(), blocked.id, regulation.id],
  );
  return { profiles, grantIds, full, blocked, contested };
}

export async function seedRecoveryPaginationSessions(
  fixture: { client: Client; sessionIds: string[] },
  previousSession: { timestamp: string },
) {
  const start = DateTime.fromISO(previousSession.timestamp, { zone: CENTER_TIME_ZONE }).plus({ hours: 1 });
  const ids = Array.from({ length: 100 }, () => randomUUID()).sort();
  fixture.sessionIds.push(...ids);
  await fixture.client.query(
    `insert into class_sessions (id, local_date, starts_at_utc, ends_at_utc, max_capacity)
     select id, $2, starts_at, starts_at + interval '1 hour', 1
     from (
       select id, $3::timestamptz + least(position, 99) * interval '1 minute'
         + interval '456 microseconds' as starts_at
       from unnest($1::text[]) with ordinality as sessions(id, position)
     ) as dated_sessions`,
    [ids, start.toISODate(), start.toJSDate()],
  );
  return { ids, sharedTimestamp: start.plus({ minutes: 99 }).toJSDate().toISOString() };
}

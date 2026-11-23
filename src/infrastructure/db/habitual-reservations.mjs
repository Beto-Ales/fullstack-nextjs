import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

/** @typedef {Pick<import("drizzle-orm/node-postgres").NodePgDatabase, "execute">} QueryExecutor */
/** @typedef {{ classSessionId: string, capacity: number, regulationVersionId: string }} SessionSeats */
/** @typedef {{ studentProfileId: string, habitualAssignmentId?: string | null }} HabitualSeat */

/** @param {QueryExecutor} tx @param {string} templateId */
export async function lockTemplateAssignments(tx, templateId) {
  await tx.execute(sql`select pg_advisory_xact_lock(903000044, hashtext(${templateId}))`);
}

/** @param {QueryExecutor} tx @param {Iterable<string>} templateIds */
export async function lockTemplatesInOrder(tx, templateIds) {
  const keys = await tx.execute(sql`
    select distinct hashtext(value) as key
    from jsonb_array_elements_text(${JSON.stringify([...templateIds])}::jsonb)
    order by key
  `);
  for (const { key } of keys.rows) await tx.execute(sql`select pg_advisory_xact_lock(903000044, ${key}::int)`);
}

/** @param {QueryExecutor} tx @param {{ templateId: string, localDate: string }[]} candidates */
export async function lockExistingGeneratedSessions(tx, candidates) {
  if (!candidates.length) return;
  await tx.execute(sql`
    select s.id from class_sessions s
    join jsonb_to_recordset(${JSON.stringify(candidates.map(({ templateId, localDate }) => ({ templateId, localDate })))}::jsonb)
      as candidate("templateId" text, "localDate" date)
      on s.template_id = candidate."templateId" and s.local_date = candidate."localDate"
    order by s.id for update of s
  `);
}

/** @param {string | import("drizzle-orm").SQLWrapper} classSessionId */
export function sessionUsageCounts(classSessionId) {
  return {
    confirmedReservations: /** @type {import("drizzle-orm").SQL<number>} */ (sql`(
      select count(*)::int from class_reservations where class_session_id = ${classSessionId} and status = 'CONFIRMED'
    )`),
    blockedSpots: /** @type {import("drizzle-orm").SQL<number>} */ (sql`(
      select coalesce(sum(blocked_spots), 0)::int from session_capacity_blocks where class_session_id = ${classSessionId} and is_active
    )`),
  };
}

/** @param {QueryExecutor} tx @param {string} classSessionId */
export async function readSessionUsage(tx, classSessionId) {
  const { confirmedReservations, blockedSpots } = sessionUsageCounts(classSessionId);
  const result = await tx.execute(sql`select ${confirmedReservations} as "confirmedReservations", ${blockedSpots} as "blockedSpots"`);
  return /** @type {{ confirmedReservations: number, blockedSpots: number }} */ (result.rows[0]);
}

/** @param {QueryExecutor} tx @param {{ classSessionId: string, capacity: number }} session @param {string[]} studentProfileIds */
async function assessHabitualSeats(tx, session, studentProfileIds) {
  if (!studentProfileIds.length) return { pending: [], capacityConflict: false };
  const existing = await tx.execute(sql`
    select student_profile_id from class_reservations
    where class_session_id = ${session.classSessionId} and status = 'CONFIRMED'
  `);
  const confirmed = new Set(existing.rows.map((row) => row.student_profile_id));
  const pending = studentProfileIds.filter((id) => !confirmed.has(id));
  if (!pending.length) return { pending, capacityConflict: false };

  const { confirmedReservations, blockedSpots } = await readSessionUsage(tx, session.classSessionId);
  return { pending, capacityConflict: confirmedReservations + blockedSpots + pending.length > session.capacity };
}

/**
 * Reserve the whole group while holding the session row lock or owning its uncommitted insert.
 * @param {QueryExecutor} tx
 * @param {SessionSeats} session
 * @param {HabitualSeat[]} students
 */
export async function reserveHabitualSeats(tx, session, students) {
  const { pending, capacityConflict } = await assessHabitualSeats(tx, session, students.map(({ studentProfileId }) => studentProfileId));
  if (!pending.length || capacityConflict) return { reserved: 0, capacityConflict };
  const assignmentByStudent = new Map(students.map(({ studentProfileId, habitualAssignmentId }) =>
    [studentProfileId, habitualAssignmentId ?? null]));
  await tx.execute(sql`
    insert into class_reservations
      (id, class_session_id, student_profile_id, status, origin, regulation_version_id, habitual_assignment_id)
    values ${sql.join(pending.map((studentId) =>
      sql`(${randomUUID()}, ${session.classSessionId}, ${studentId}, 'CONFIRMED', 'ORDINARY', ${session.regulationVersionId}, ${assignmentByStudent.get(studentId) ?? null})`
    ), sql`, `)}
  `);
  return { reserved: pending.length, capacityConflict: false };
}

/** @param {{ templateId: string | import("drizzle-orm").SQLWrapper, localDate: string | import("drizzle-orm").SQLWrapper }} session */
export function activeHabitualStudents(session) {
  return sql`
    select distinct a.student_profile_id, p.user_id
    from student_template_assignments a
    join student_profiles p on p.id = a.student_profile_id
    join users u on u.id = p.user_id
    where a.template_id = ${session.templateId}
      and a.status <> 'CANCELLED'
      and a.effective_from <= ${session.localDate}
      and (a.effective_to is null or a.effective_to >= ${session.localDate})
      and u.status = 'ACTIVE'
  `;
}

/** @param {QueryExecutor} tx @param {{ templateId: string, localDate: string }} session */
async function readHabitualStudentIds(tx, session) {
  const assignments = await tx.execute(activeHabitualStudents(session));
  return /** @type {{ student_profile_id: string }[]} */ (assignments.rows).map((row) => row.student_profile_id);
}

/**
 * Resolve the assignment that provably originated a generated habitual reservation.
 * Overlapping assignments for the same student and date make the origin ambiguous, so no reference is kept.
 * @param {QueryExecutor} tx @param {{ templateId: string, localDate: string }} session
 */
async function readHabitualAssignmentIds(tx, session) {
  const result = await tx.execute(sql`
    select a.student_profile_id as "studentProfileId",
      case when count(distinct a.id) = 1 then min(a.id) end as "assignmentId"
    from student_template_assignments a
    join student_profiles p on p.id = a.student_profile_id
    join users u on u.id = p.user_id
    where a.template_id = ${session.templateId}
      and a.status <> 'CANCELLED'
      and a.effective_from <= ${session.localDate}
      and (a.effective_to is null or a.effective_to >= ${session.localDate})
      and u.status = 'ACTIVE'
    group by a.student_profile_id
  `);
  return new Map(/** @type {{ studentProfileId: string, assignmentId: string | null }[]} */ (result.rows)
    .map(({ studentProfileId, assignmentId }) => [studentProfileId, assignmentId]));
}

/** @param {QueryExecutor} tx @param {{ templateId: string, localDate: string }} session */
async function readHabitualStudents(tx, session) {
  const studentIds = await readHabitualStudentIds(tx, session);
  const assignmentIds = await readHabitualAssignmentIds(tx, session);
  return studentIds.map((studentProfileId) => ({ studentProfileId, habitualAssignmentId: assignmentIds.get(studentProfileId) ?? null }));
}

/** @typedef {SessionSeats & { templateId: string, localDate: string }} GeneratedSessionSeats */

/** @param {QueryExecutor} tx @param {GeneratedSessionSeats[]} sessions */
export async function reserveGeneratedSessionHabitualSeats(tx, sessions) {
  const bookings = [];
  const profileIds = new Set();
  for (const session of sessions) {
    const students = await readHabitualStudents(tx, session);
    for (const { studentProfileId } of students) profileIds.add(studentProfileId);
    bookings.push({ session, students });
  }
  if (profileIds.size) {
    await tx.execute(sql`
      select id from student_profiles
      where id in (${sql.join([...profileIds], sql`, `)})
      order by id for key share
    `);
  }
  let reserved = 0;
  const conflicts = [];
  for (const { session, students } of bookings) {
    const result = await reserveHabitualSeats(tx, session, students);
    reserved += result.reserved;
    if (result.capacityConflict) conflicts.push(session.classSessionId);
  }
  return { reserved, conflicts };
}

/** @param {QueryExecutor} tx @param {{ templateId: string, localDate: string, now: Date, maxClassCapacity: number }} candidate */
export async function findExistingHabitualCapacityConflict(tx, candidate) {
  const result = await tx.execute(sql`
    select id, max_capacity from class_sessions
    where template_id = ${candidate.templateId} and local_date = ${candidate.localDate}
      and status = 'SCHEDULED' and starts_at_utc >= ${candidate.now}
  `);
  const [existing] = /** @type {{ id: string, max_capacity: number }[]} */ (result.rows);
  if (!existing) return null;

  const { capacityConflict } = await assessHabitualSeats(tx, {
    classSessionId: existing.id,
    capacity: Math.min(existing.max_capacity, candidate.maxClassCapacity),
  }, await readHabitualStudentIds(tx, candidate));
  return capacityConflict ? existing.id : null;
}

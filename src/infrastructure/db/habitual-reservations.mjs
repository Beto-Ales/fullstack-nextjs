import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

/** @typedef {Pick<import("drizzle-orm/node-postgres").NodePgDatabase, "execute">} QueryExecutor */
/** @typedef {{ classSessionId: string, capacity: number, regulationVersionId: string }} SessionSeats */

/** @param {QueryExecutor} tx @param {string} templateId */
export async function lockTemplateAssignments(tx, templateId) {
  await tx.execute(sql`select pg_advisory_xact_lock(903000044, hashtext(${templateId}))`);
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
 * @param {string[]} studentProfileIds
 */
export async function reserveHabitualSeats(tx, session, studentProfileIds) {
  const { pending, capacityConflict } = await assessHabitualSeats(tx, session, studentProfileIds);
  if (!pending.length || capacityConflict) return { reserved: 0, capacityConflict };
  await tx.execute(sql`
    insert into class_reservations (id, class_session_id, student_profile_id, status, origin, regulation_version_id)
    values ${sql.join(pending.map((studentId) =>
      sql`(${randomUUID()}, ${session.classSessionId}, ${studentId}, 'CONFIRMED', 'ORDINARY', ${session.regulationVersionId})`
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

/** @param {QueryExecutor} tx @param {SessionSeats & { templateId: string, localDate: string }} session */
export async function reserveGeneratedSessionHabitualSeats(tx, session) {
  return reserveHabitualSeats(tx, session, await readHabitualStudentIds(tx, session));
}

/** @param {QueryExecutor} tx @param {{ templateId: string, localDate: string, now: Date, maxClassCapacity: number }} candidate */
export async function findExistingHabitualCapacityConflict(tx, candidate) {
  const result = await tx.execute(sql`
    select id, max_capacity from class_sessions
    where template_id = ${candidate.templateId} and local_date = ${candidate.localDate}
      and status = 'SCHEDULED' and starts_at_utc >= ${candidate.now}
    for update
  `);
  const [existing] = /** @type {{ id: string, max_capacity: number }[]} */ (result.rows);
  if (!existing) return null;

  const { capacityConflict } = await assessHabitualSeats(tx, {
    classSessionId: existing.id,
    capacity: Math.min(existing.max_capacity, candidate.maxClassCapacity),
  }, await readHabitualStudentIds(tx, candidate));
  return capacityConflict ? existing.id : null;
}

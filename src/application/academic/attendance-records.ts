import "server-only";

import { and, isNull, type SQL } from "drizzle-orm";

import type { db } from "@/src/infrastructure/db/client";
import { reservationAttendanceRecords } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Call with the session row locked so other attendance and cancellation writes wait.
export async function findActiveAttendance(tx: TransactionClient, scope: SQL) {
  const [record] = await tx.select({
    id: reservationAttendanceRecords.id,
    outcome: reservationAttendanceRecords.outcome,
  }).from(reservationAttendanceRecords)
    .where(and(scope, isNull(reservationAttendanceRecords.supersededAt)))
    .limit(1);
  return record;
}

export async function assertNoActiveAttendance(tx: TransactionClient, scope: SQL): Promise<void> {
  if (await findActiveAttendance(tx, scope)) {
    throw new ApplicationError("Attendance has already been recorded.", "attendance_already_recorded", 409, true);
  }
}

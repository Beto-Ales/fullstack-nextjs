import "server-only";

import { and, eq, gt, sql, type SQLWrapper } from "drizzle-orm";

import type { db } from "@/src/infrastructure/db/client";
import { classSessions } from "@/src/infrastructure/db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function sessionStartsAfter(reference: SQLWrapper) {
  return gt(classSessions.startsAtUtc, reference);
}

// Call after holding the session and any locks that could delay admission of the new reservation.
export async function canAdmitNewReservation(tx: Transaction, classSessionId: string): Promise<boolean> {
  const [session] = await tx.select({ id: classSessions.id }).from(classSessions).where(and(
    eq(classSessions.id, classSessionId),
    eq(classSessions.status, "SCHEDULED"),
    sessionStartsAfter(sql`clock_timestamp()`),
  ));
  return Boolean(session);
}

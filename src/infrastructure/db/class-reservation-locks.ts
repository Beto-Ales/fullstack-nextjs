import "server-only";

import { eq } from "drizzle-orm";

import type { db } from "@/src/infrastructure/db/client";
import { classReservations, classSessions } from "@/src/infrastructure/db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lockClassSessionForReservation(tx: Transaction, reservationId: string) {
  // Use the same lock order as session cancellation and student withdrawal.
  await tx.select({ id: classSessions.id }).from(classSessions)
    .innerJoin(classReservations, eq(classReservations.classSessionId, classSessions.id))
    .where(eq(classReservations.id, reservationId)).for("no key update", { of: classSessions });
}

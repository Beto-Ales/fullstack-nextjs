import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/src/infrastructure/db/client";
import { studentProfiles, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function requireActiveStudentForBooking(tx: Transaction, studentProfileId: string) {
  const [student] = await tx.select({ id: users.id }).from(studentProfiles)
    .innerJoin(users, eq(users.id, studentProfiles.userId))
    .where(and(eq(studentProfiles.id, studentProfileId), eq(users.role, "STUDENT"), eq(users.status, "ACTIVE")))
    .for("share", { of: users });
  if (!student) {
    throw new ApplicationError("El alumno no tiene una cuenta activa.", "student_inactive", 409, true);
  }
}

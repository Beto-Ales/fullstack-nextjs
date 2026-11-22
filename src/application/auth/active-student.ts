import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/src/infrastructure/db/client";
import { studentProfiles, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockActiveStudent(tx: Transaction, identity: { studentProfileId: string } | { userId: string }) {
  const owner = "userId" in identity ? eq(users.id, identity.userId) : eq(studentProfiles.id, identity.studentProfileId);
  const [student] = await tx.select({ profileId: studentProfiles.id }).from(studentProfiles)
    .innerJoin(users, eq(users.id, studentProfiles.userId))
    .where(and(owner, eq(users.role, "STUDENT"), eq(users.status, "ACTIVE")))
    .for("share", { of: users });
  if (!student) {
    throw new ApplicationError("El alumno no tiene una cuenta activa.", "student_inactive", 409, true);
  }
  return student.profileId;
}

export async function requireActiveStudentForBooking(tx: Transaction, studentProfileId: string) {
  await lockActiveStudent(tx, { studentProfileId });
}

export function requireActiveStudentForCancellation(tx: Transaction, userId: string) {
  return lockActiveStudent(tx, { userId });
}

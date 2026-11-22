import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { studentEditSchema, type StudentEditData } from "@/src/application/academic/student-edit-schema";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import { studentProfileEdits, studentProfiles, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

export const studentEditVersion = sql<string>`extract(epoch from ${studentProfiles.updatedAt})::text`;
const requestSchema = z.strictObject({
  studentProfileId: z.uuid(),
  version: z.string().max(32).regex(/^-?\d+\.\d{6}$/),
  data: studentEditSchema,
});

function forbidden() {
  return new ApplicationError("Acceso restringido a la administración.", "forbidden", 403, true);
}

export async function updateStudentDetails(actor: { role: UserRole; userId: string }, input: unknown) {
  if (actor.role !== "SUPER_ADMIN") throw forbidden();
  const { studentProfileId, version, data } = requestSchema.parse(input);

  try {
    return await db.transaction(async (tx) => {
      const [admin] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.id, actor.userId), eq(users.role, "SUPER_ADMIN"), eq(users.status, "ACTIVE")))
        .for("share");
      if (!admin) throw forbidden();

      const [student] = await tx.select({
        userId: users.id, status: users.status, emailNormalized: users.emailNormalized, version: studentEditVersion,
        firstName: studentProfiles.firstName, lastName: studentProfiles.lastName,
        email: users.email, contactEmail: studentProfiles.contactEmail, contactPhone: studentProfiles.contactPhone,
      }).from(studentProfiles).innerJoin(users, eq(users.id, studentProfiles.userId))
        .where(and(eq(studentProfiles.id, studentProfileId), eq(users.role, "STUDENT")))
        .for("no key update", { of: [users, studentProfiles] });
      if (!student) throw new ApplicationError("El alumno no está disponible.", "student_not_found", 404, true);
      if (student.status !== "ACTIVE") {
        throw new ApplicationError("La cuenta está desactivada.", "student_disabled", 409, true);
      }

      const changes: typeof studentProfileEdits.$inferInsert.changes = {};
      for (const field of Object.keys(data) as (keyof StudentEditData)[]) {
        if (student[field] !== data[field]) changes[field] = { before: student[field], after: data[field] };
      }
      const emailChanged = data.email !== student.email || data.email !== student.emailNormalized;
      if (emailChanged && !changes.email) changes.email = { before: student.emailNormalized, after: data.email };
      if (!Object.keys(changes).length) return { updated: false };
      if (student.version !== version) {
        throw new ApplicationError("Los datos cambiaron desde que abriste el formulario.", "student_edit_conflict", 409, true);
      }

      const { email, ...details } = data;
      await tx.update(studentProfiles).set({
        ...details,
        updatedAt: sql`greatest(clock_timestamp(), ${studentProfiles.updatedAt} + interval '1 microsecond')`,
      }).where(eq(studentProfiles.id, studentProfileId));
      if (emailChanged) {
        await tx.update(users).set({ email, emailNormalized: email, updatedAt: new Date() })
          .where(eq(users.id, student.userId));
      }
      await tx.insert(studentProfileEdits).values({
        id: randomUUID(), studentProfileId, editedByUserId: admin.id, operation: "UPDATE_STUDENT_DETAILS", changes,
      });
      return { updated: true };
    });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : null;
    if (cause && typeof cause === "object" && "code" in cause && "constraint" in cause
      && cause.code === "23505" && cause.constraint === "users_email_normalized_unique_idx") {
      throw new ApplicationError("Este correo de acceso ya está en uso.", "student_email_duplicate", 409, true);
    }
    throw error;
  }
}

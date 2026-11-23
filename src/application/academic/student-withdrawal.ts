import "server-only";

import { and, asc, eq, exists, gt, gte, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { regulationDate, resolveCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { lockStudentProfile, resolvePendingCancellationCredits } from "@/src/application/credits/credit-service";
import { cancelFutureRecoveriesForWithdrawal } from "@/src/application/recovery/recovery-service";
import type { UserRole } from "@/src/domain/auth/roles";
import { db } from "@/src/infrastructure/db/client";
import { lockTemplatesInOrder } from "@/src/infrastructure/db/habitual-reservations.mjs";
import { classReservations, classSessions, classTemplates, sessions, studentProfiles, studentTemplateAssignments, studentWithdrawals, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";

export async function withdrawStudent(actor: { userId: string; role: UserRole }, input: unknown) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Acceso restringido a la administración.", "forbidden", 403, true);
  }
  const { studentProfileId } = z.object({ studentProfileId: z.uuid() }).parse(input);

  return db.transaction(async (tx) => {
    const [student] = await tx.select({ userId: users.id, status: users.status }).from(studentProfiles)
      .innerJoin(users, eq(users.id, studentProfiles.userId))
      .where(and(eq(studentProfiles.id, studentProfileId), eq(users.role, "STUDENT")))
      .for("no key update", { of: users });
    if (!student) {
      throw new ApplicationError("No se encontró el alumno.", "student_not_found", 404, true);
    }
    if (student.status === "DISABLED") return { withdrawn: false, releasedReservations: 0, cancelledRecoveries: 0 };

    // Match the booking and generation lock order: student, templates, then sessions.
    const confirmedBookings = tx.select({ id: classReservations.classSessionId }).from(classReservations)
      .where(and(
        eq(classReservations.studentProfileId, studentProfileId),
        eq(classReservations.status, "CONFIRMED"),
        eq(classReservations.classSessionId, classSessions.id),
      ));
    const assignments = await tx.selectDistinct({ id: studentTemplateAssignments.templateId })
      .from(studentTemplateAssignments)
      .where(eq(studentTemplateAssignments.studentProfileId, studentProfileId));
    const bookedTemplates = await tx.selectDistinct({ id: classSessions.templateId }).from(classSessions)
      .where(and(isNotNull(classSessions.templateId), exists(confirmedBookings)));
    const templateIds = new Set([...assignments, ...bookedTemplates].map(({ id }) => id).filter(id => id !== null));
    await lockTemplatesInOrder(tx, templateIds);
    await tx.select({ id: classSessions.id }).from(classSessions).where(exists(confirmedBookings))
      .orderBy(asc(classSessions.id)).for("no key update");
    await lockStudentProfile(tx, studentProfileId);

    const withdrawnAt = new Date();
    const localDate = regulationDate(withdrawnAt);
    await tx.update(users).set({ status: "DISABLED", deactivatedAt: withdrawnAt, updatedAt: withdrawnAt })
      .where(eq(users.id, student.userId));
    await tx.delete(sessions).where(eq(sessions.userId, student.userId));

    const endedAssignments = await tx.update(studentTemplateAssignments)
      .set({ status: "ENDED", effectiveTo: localDate, updatedAt: withdrawnAt })
      .from(classTemplates).where(and(
        eq(studentTemplateAssignments.templateId, classTemplates.id),
        or(isNull(classTemplates.effectiveTo), gte(classTemplates.effectiveTo, localDate)),
        eq(studentTemplateAssignments.studentProfileId, studentProfileId),
        or(
          isNull(studentTemplateAssignments.effectiveTo),
          gt(studentTemplateAssignments.effectiveTo, localDate),
          and(eq(studentTemplateAssignments.effectiveTo, localDate), eq(studentTemplateAssignments.status, "ACTIVE")),
        ),
      )).returning({ id: studentTemplateAssignments.id });

    const regulation = await resolveCurrentAcademicRegulation(tx, withdrawnAt);
    const releasedReservations = await tx.update(classReservations).set({
      status: "CANCELLED",
      cancelledAt: withdrawnAt,
      cancelledByUserId: actor.userId,
      cancellationRegulationVersionId: regulation.id,
      updatedAt: withdrawnAt,
    }).from(classSessions).where(and(
      eq(classReservations.classSessionId, classSessions.id),
      eq(classReservations.studentProfileId, studentProfileId),
      eq(classReservations.status, "CONFIRMED"),
      eq(classReservations.origin, "ORDINARY"),
      gt(classSessions.startsAtUtc, withdrawnAt),
    )).returning({ id: classReservations.id });

    const cancelledRecoveries = await cancelFutureRecoveriesForWithdrawal(tx, {
      studentProfileId, cancelledAt: withdrawnAt, cancelledByUserId: actor.userId, regulation,
    });
    await tx.insert(studentWithdrawals).values({
      studentUserId: student.userId,
      withdrawnByUserId: actor.userId,
      withdrawnAt,
      endedAssignmentIds: endedAssignments.map(({ id }) => id),
      releasedReservationIds: releasedReservations.map(({ id }) => id),
      cancelledRecoveries,
    });
    await resolvePendingCancellationCredits(tx, studentProfileId);
    return { withdrawn: true, releasedReservations: releasedReservations.length, cancelledRecoveries: cancelledRecoveries.length };
  });
}

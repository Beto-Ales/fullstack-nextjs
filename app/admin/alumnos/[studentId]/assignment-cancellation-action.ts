"use server";

import { refresh, revalidatePath } from "next/cache";
import { z, ZodError } from "zod";

import { cancelFutureAssignment } from "@/src/application/academic/assignment-cancellation";
import { isApplicationError } from "@/src/infrastructure/errors";
import { requireRole } from "@/src/interfaces/auth/session";

export type AssignmentCancellationState =
  | { status: "idle" }
  | {
    status: "success";
    message: string;
    cancelledReservations: number;
    ambiguousReservations: number;
  }
  | { status: "error"; message: string; reasonError?: string };

const invalidRequest = "La solicitud de anulación no es válida. Actualiza la ficha e inténtalo de nuevo.";
const reasonError = "Escribe un motivo de entre 3 y 300 caracteres, sin contar los espacios de los extremos.";

const domainErrors: Record<string, string> = {
  assignment_not_found: "La asignación ya no está disponible en esta ficha.",
  assignment_already_started: "La asignación ya ha comenzado. Usa la finalización ordinaria.",
  student_inactive: "El alumno no tiene una cuenta activa.",
  assignment_cancellation_inconsistent: "La asignación requiere revisión administrativa antes de continuar.",
  assignment_cancelled_without_audit: "La asignación figura anulada sin auditoría asociada y requiere revisión administrativa.",
  forbidden: "No tienes permiso para anular esta asignación.",
};

const stateCodes = new Set([
  "assignment_not_found",
  "assignment_already_started",
  "student_inactive",
  "assignment_cancellation_inconsistent",
  "assignment_cancelled_without_audit",
]);

function reservationCount(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function resultMessage(result: {
  cancelled: boolean;
  cancelledReservationIds: string[];
  ambiguousReservationIds: string[];
}) {
  const base = result.cancelled
    ? "Asignación anulada. No generará nuevas reservas habituales. Se conservan las fechas originales y el historial."
    : "La asignación ya estaba anulada. No se registró una nueva operación.";
  const cancelled = result.cancelledReservationIds.length === 0
    ? "No había reservas futuras vinculadas que cancelar."
    : result.cancelled
      ? result.cancelledReservationIds.length === 1
        ? "Se canceló 1 reserva futura vinculada."
        : `Se cancelaron ${result.cancelledReservationIds.length} reservas futuras vinculadas.`
      : `La anulación registrada canceló ${reservationCount(result.cancelledReservationIds.length, "reserva futura vinculada", "reservas futuras vinculadas")}.`;
  const ambiguous = result.ambiguousReservationIds.length === 0
    ? "No quedaron reservas pendientes de revisión por procedencia ambigua."
    : result.ambiguousReservationIds.length === 1
      ? "Una reserva existente no se pudo atribuir con certeza, no se canceló y queda para revisión administrativa."
      : `${result.ambiguousReservationIds.length} reservas existentes no se pudieron atribuir con certeza, no se cancelaron y quedan para revisión administrativa.`;
  return `${base} ${cancelled} ${ambiguous}`;
}

function revalidateProfile(studentProfileId: string) {
  revalidatePath(`/admin/alumnos/${studentProfileId}`);
  revalidatePath("/admin");
  revalidatePath("/student");
}

export async function cancelAssignmentAction(
  studentProfileId: string,
  assignmentId: string,
  _previous: AssignmentCancellationState,
  form: FormData,
): Promise<AssignmentCancellationState> {
  const admin = await requireRole("SUPER_ADMIN");
  if (!z.uuid().safeParse(studentProfileId).success) {
    return { status: "error", message: invalidRequest };
  }

  const entries = [...form].filter(([key]) => !key.startsWith("$ACTION_"));
  if (entries.length !== 1 || entries[0][0] !== "reason" || typeof entries[0][1] !== "string") {
    return { status: "error", message: invalidRequest };
  }
  const reason = entries[0][1];

  try {
    const result = await cancelFutureAssignment(admin, { assignmentId, reason });
    revalidateProfile(studentProfileId);
    return {
      status: "success",
      message: resultMessage(result),
      cancelledReservations: result.cancelledReservationIds.length,
      ambiguousReservations: result.ambiguousReservationIds.length,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const invalidReason = error.issues.some(({ path }) => path[0] === "reason");
      return invalidReason
        ? { status: "error", message: "Revisa el motivo de anulación.", reasonError }
        : { status: "error", message: invalidRequest };
    }
    if (isApplicationError(error)) {
      if (stateCodes.has(error.code)) refresh();
      const message = domainErrors[error.code];
      if (message) return { status: "error", message };
    }
    return { status: "error", message: "No se pudo anular la asignación. Actualiza la ficha e inténtalo de nuevo." };
  }
}

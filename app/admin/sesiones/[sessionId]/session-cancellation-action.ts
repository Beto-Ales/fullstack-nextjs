"use server";

import { refresh, revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { cancelSessionEnrollment } from "@/src/application/academic/academic-service";
import { isApplicationError } from "@/src/infrastructure/errors";
import { requireRole } from "@/src/interfaces/auth/session";

export type SessionCancellationState =
  | { status: "idle" }
  | { status: "error" | "success"; message: string };

const messages: Record<string, string> = {
  reservation_not_found: "La reserva ya no está disponible en esta sesión.",
  reservation_not_ordinary: "Solo se pueden cancelar inscripciones ordinarias desde este formulario.",
  reservation_not_confirmed: "La reserva ya no está confirmada.",
  reservation_already_cancelled: "La reserva ya tiene una cancelación registrada.",
  session_not_cancellable: "Solo se pueden cancelar inscripciones en sesiones futuras y programadas.",
  attendance_already_recorded: "La reserva ya tiene un resultado de asistencia.",
  cancellation_id_conflict: "Esta solicitud ya se utilizó. Vuelve a abrir el formulario.",
};

export async function submitSessionCancellation(
  sessionId: string,
  _previous: SessionCancellationState,
  form: FormData,
): Promise<SessionCancellationState> {
  const admin = await requireRole("SUPER_ADMIN");
  let created: boolean;
  try {
    ({ created } = await cancelSessionEnrollment(admin, {
      classSessionId: sessionId,
      reservationId: form.get("reservationId"),
      cancellationId: form.get("cancellationId"),
      reason: form.get("reason"),
    }));
  } catch (error) {
    if (error instanceof ZodError) {
      const reasonInvalid = error.issues.some(({ path }) => path[0] === "reason");
      return { status: "error", message: reasonInvalid
        ? "Escribe un motivo de entre 3 y 300 caracteres, sin contar los espacios de los extremos."
        : "La solicitud de cancelación no es válida. Actualiza el detalle." };
    }
    if (isApplicationError(error) && messages[error.code]) {
      refresh();
      return { status: "error", message: messages[error.code] };
    }
    return { status: "error", message: "No se pudo cancelar la inscripción. Actualiza el detalle antes de intentarlo de nuevo." };
  }

  revalidatePath(`/admin/sesiones/${sessionId}`);
  revalidatePath("/admin");
  revalidatePath("/student");
  return { status: "success", message: created ? "Inscripción cancelada." : "Esta cancelación ya estaba registrada." };
}

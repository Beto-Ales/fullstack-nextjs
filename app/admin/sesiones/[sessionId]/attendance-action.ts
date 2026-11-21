"use server";

import { refresh } from "next/cache";
import { ZodError } from "zod";

import { isApplicationError } from "@/src/infrastructure/errors";
import { correctAttendanceAction, recordAttendanceAction } from "@/src/interfaces/academic/actions";
import { requireRole } from "@/src/interfaces/auth/session";

export type AttendanceFormState =
  | { status: "idle" }
  | { status: "success" | "error"; message: string };

const attendanceErrors: Record<string, string> = {
  session_not_ended: "El registro y la corrección estarán disponibles cuando finalice la clase.",
  session_cancelled: "La sesión está cancelada. Actualiza el detalle para consultar el historial.",
  reservation_not_found: "La reserva ya no está disponible en esta sesión. Actualiza el detalle.",
  reservation_not_confirmed: "La reserva ya no está confirmada. Actualiza el detalle.",
  reservation_cancelled: "La reserva está cancelada. Actualiza el detalle para consultar el historial.",
  attendance_already_recorded: "Ya hay un resultado registrado. Usa la corrección si necesitas cambiarlo.",
  attendance_not_found: "El registro que quieres corregir ya no está disponible. Actualiza el detalle.",
  attendance_same_outcome: "El resultado guardado ya coincide con el seleccionado. Revisa el estado actual antes de corregirlo.",
};

export async function submitAttendanceForm(
  classSessionId: string,
  reservationId: string,
  correcting: boolean,
  _previous: AttendanceFormState,
  form: FormData,
): Promise<AttendanceFormState> {
  await requireRole("SUPER_ADMIN");
  const input = { classSessionId, reservationId, outcome: form.get("outcome") };
  let message: string;

  try {
    if (correcting) {
      await correctAttendanceAction({ ...input, reason: form.get("reason") });
      message = "Corrección guardada.";
    } else {
      const result = await recordAttendanceAction(input);
      message = result.updated ? "Asistencia registrada." : "El resultado ya estaba registrado.";
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        status: "error",
        message: error.issues.some(({ path }) => path[0] === "reason")
          ? "Escribe un motivo de entre 3 y 300 caracteres, sin contar los espacios del principio y del final."
          : "Selecciona un resultado válido.",
      };
    }
    if (isApplicationError(error)) {
      const message = attendanceErrors[error.code];
      if (error.code === "attendance_already_recorded" || error.code === "attendance_same_outcome") refresh();
      if (message) return { status: "error", message };
    }
    return { status: "error", message: "No se pudo guardar la asistencia. Actualiza el detalle antes de volver a intentarlo." };
  }

  refresh();
  return { status: "success", message };
}

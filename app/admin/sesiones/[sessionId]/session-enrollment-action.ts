"use server";

import { randomUUID } from "node:crypto";
import { refresh, revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { enrollStudentInSession, searchSessionEnrollmentStudents } from "@/src/application/academic/academic-service";
import { isApplicationError } from "@/src/infrastructure/errors";
import { requireRole } from "@/src/interfaces/auth/session";

export type StudentSearchState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "results"; hasMore: boolean; students: { id: string; label: string; reservationId: string }[] };

export type EnrollmentState =
  | { status: "idle" }
  | { status: "success" | "error"; message: string };

const enrollmentErrors: Record<string, string> = {
  student_inactive: "El alumno ya no tiene una cuenta activa. Busca otro alumno.",
  session_not_found: "La sesión ya no está disponible.",
  session_not_reservable: "Solo se pueden inscribir alumnos en sesiones futuras y programadas.",
  reservation_already_confirmed: "El alumno ya tiene una reserva confirmada en esta sesión.",
  no_spots_available: "Ya no quedan plazas reservables. Se ha actualizado el aforo.",
  enrollment_id_conflict: "Esta solicitud ya se utilizó. Busca al alumno de nuevo.",
  enrollment_already_cancelled: "La inscripción de esta solicitud ya se canceló. Busca al alumno para iniciar una nueva.",
};

export async function searchEnrollmentStudents(
  classSessionId: string,
  _previous: StudentSearchState,
  form: FormData,
): Promise<StudentSearchState> {
  const admin = await requireRole("SUPER_ADMIN");
  try {
    const { students, hasMore } = await searchSessionEnrollmentStudents(admin, { classSessionId, query: form.get("query") });
    return { status: "results", hasMore, students: students.map((student) => ({ ...student, reservationId: randomUUID() })) };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof ZodError && error.issues.some(({ path }) => path[0] === "query")
        ? "Introduce entre 2 y 120 caracteres para buscar."
        : "No se pudo buscar alumnos en esta sesión. Actualiza el detalle y vuelve a intentarlo.",
    };
  }
}

export async function submitSessionEnrollment(
  classSessionId: string,
  _previous: EnrollmentState,
  form: FormData,
): Promise<EnrollmentState> {
  const admin = await requireRole("SUPER_ADMIN");
  let created: boolean;
  try {
    ({ created } = await enrollStudentInSession(admin, {
      classSessionId,
      studentProfileId: form.get("studentProfileId"),
      reservationId: form.get("reservationId"),
    }));
  } catch (error) {
    if (error instanceof ZodError) {
      return { status: "error", message: "Selecciona un alumno válido de los resultados de la búsqueda." };
    }
    if (isApplicationError(error) && enrollmentErrors[error.code]) {
      refresh();
      return { status: "error", message: enrollmentErrors[error.code] };
    }
    return { status: "error", message: "No se pudo confirmar la inscripción. Actualiza el detalle y vuelve a intentarlo." };
  }

  revalidatePath(`/admin/sesiones/${classSessionId}`);
  revalidatePath("/admin");
  revalidatePath("/student");
  return { status: "success", message: created ? "Inscripción ordinaria confirmada." : "Esta inscripción ya estaba confirmada." };
}

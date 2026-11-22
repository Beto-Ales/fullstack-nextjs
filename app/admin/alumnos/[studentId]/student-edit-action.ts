"use server";

import { refresh } from "next/cache";
import { ZodError } from "zod";

import { updateStudentDetails } from "@/src/application/academic/student-edit-service";
import type { StudentEditData } from "@/src/application/academic/student-edit-schema";
import { isApplicationError } from "@/src/infrastructure/errors";
import { requireRole } from "@/src/interfaces/auth/session";

export type StudentEditState =
  | { status: "idle" }
  | { status: "success" | "conflict"; message: string }
  | { status: "error"; message: string; fields?: Partial<Record<keyof StudentEditData, string>> };

const fieldErrors = {
  firstName: "Escribe un nombre de 1 a 120 caracteres, sin caracteres de control.",
  lastName: "Escribe apellidos de 1 a 120 caracteres, sin caracteres de control.",
  email: "Escribe un correo de acceso válido de hasta 255 caracteres.",
  contactEmail: "Escribe un correo de contacto válido de hasta 255 caracteres o déjalo vacío.",
  contactPhone: "Escribe un teléfono de 7 a 15 dígitos, con prefijo internacional opcional, o déjalo vacío.",
};

export async function submitStudentEdit(
  studentProfileId: string, version: string, _previous: StudentEditState, form: FormData,
): Promise<StudentEditState> {
  const admin = await requireRole("SUPER_ADMIN");
  const entries = [...form].filter(([key]) => !key.startsWith("$ACTION_"));
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    return { status: "error", message: "La solicitud de edición no es válida." };
  }

  try {
    const { updated } = await updateStudentDetails(admin, { studentProfileId, version, data: Object.fromEntries(entries) });
    refresh();
    return { status: "success", message: updated ? "Cambios guardados." : "Los datos ya están actualizados." };
  } catch (error) {
    if (error instanceof ZodError) {
      const fields: Partial<Record<keyof StudentEditData, string>> = {};
      for (const issue of error.issues) {
        const [group, field] = issue.path;
        if (group === "data" && typeof field === "string" && Object.hasOwn(fieldErrors, field)) {
          const key = field as keyof StudentEditData;
          fields[key] = fieldErrors[key];
        }
      }
      return { status: "error", message: Object.keys(fields).length
        ? "Revisa los campos indicados." : "La solicitud de edición no es válida.", fields };
    }
    if (isApplicationError(error)) {
      if (error.code === "student_email_duplicate") {
        return { status: "error", message: "Revisa el correo de acceso.", fields: { email: error.message } };
      }
      if (["student_edit_conflict", "student_disabled", "student_not_found"].includes(error.code)) {
        return { status: "conflict", message: error.message };
      }
    }
    return { status: "error", message: "No se pudieron guardar los cambios. Vuelve a cargar el perfil e inténtalo de nuevo." };
  }
}

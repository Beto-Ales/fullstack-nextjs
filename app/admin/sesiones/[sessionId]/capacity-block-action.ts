"use server";

import { refresh, revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { isApplicationError } from "@/src/infrastructure/errors";
import { addSessionCapacityBlockAction, releaseSessionCapacityBlockAction } from "@/src/interfaces/academic/actions";
import { requireRole } from "@/src/interfaces/auth/session";

export type CapacityBlockFormState =
  | { status: "idle" }
  | { status: "success" | "error"; message: string };

const messages: Record<string, string> = {
  session_not_found: "La sesión ya no está disponible.",
  session_not_reservable: "Solo se pueden bloquear plazas en sesiones futuras y programadas.",
  capacity_conflict: "Ya no hay plazas suficientes para este bloqueo. Se ha actualizado el aforo.",
  block_id_conflict: "Esta solicitud ya se utilizó para otro bloqueo. Revisa el aforo y vuelve a intentarlo.",
  capacity_block_not_found: "El bloqueo ya no está disponible en esta sesión.",
};

export async function submitCapacityBlockForm(
  classSessionId: string,
  blockId: string,
  operation: "block" | "release",
  _previous: CapacityBlockFormState,
  form: FormData,
): Promise<CapacityBlockFormState> {
  await requireRole("SUPER_ADMIN");
  const input = { classSessionId, blockId, reason: form.get("reason") };
  let message: string;
  try {
    if (operation === "release") {
      const result = await releaseSessionCapacityBlockAction(input);
      message = result.released ? "Bloqueo desactivado." : "El bloqueo ya estaba desactivado.";
    } else {
      const result = await addSessionCapacityBlockAction({ ...input, blockedSpots: 1 });
      message = result.created ? "Plaza bloqueada." : "Esta solicitud ya se registró.";
    }
  } catch (error) {
    if (error instanceof ZodError && error.issues.some(({ path }) => path[0] === "reason")) {
      return { status: "error", message: "Escribe un motivo de entre 3 y 300 caracteres, sin contar los espacios de los extremos." };
    }
    if (isApplicationError(error)) {
      const message = messages[error.code];
      if (["capacity_conflict", "session_not_reservable", "block_id_conflict"].includes(error.code)) refresh();
      if (message) return { status: "error", message };
    }
    return { status: "error", message: "No se pudo guardar el cambio. Actualiza el detalle antes de intentarlo de nuevo." };
  }

  revalidatePath(`/admin/sesiones/${classSessionId}`);
  revalidatePath("/admin");
  revalidatePath("/student");
  return { status: "success", message };
}

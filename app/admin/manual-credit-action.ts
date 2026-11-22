"use server";

import { ZodError } from "zod";

import { grantManualCredits, withdrawManualCredits } from "@/src/application/credits/credit-service";
import { isApplicationError } from "@/src/infrastructure/errors";
import { logger } from "@/src/infrastructure/logger";
import { requireRole } from "@/src/interfaces/auth/session";

export async function submitManualCreditAdjustment(
  kind: "grant" | "withdraw",
  studentProfileId: string,
  requestId: string,
  formData: FormData,
) {
  const actor = await requireRole("SUPER_ADMIN");
  if (kind !== "grant" && kind !== "withdraw") {
    return { status: "error", message: "El tipo de ajuste no es válido." } as const;
  }
  const input = { requestId, studentProfileId, amount: Number(formData.get("amount")), reason: formData.get("reason") };
  try {
    if (kind === "grant") await grantManualCredits(actor, input);
    else await withdrawManualCredits(actor, input);
    return { status: "success" } as const;
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues.find(({ path }) => path[0] === "amount" || path[0] === "reason");
      const message = issue?.path[0] === "amount" ? "La cantidad debe ser un número entero entre 1 y 100."
        : issue ? "El motivo debe tener entre 3 y 300 caracteres." : "Revisa la solicitud de ajuste.";
      return { status: "error", message } as const;
    }
    if (isApplicationError(error) && error.expose) {
      const message = error.code === "student_profile_not_found" ? "No se encontró el alumno." : error.message;
      return { status: error.code === "manual_credit_request_conflict" ? "conflict" : "error", message } as const;
    }
    logger.error("Manual credit adjustment result unavailable.", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return { status: "unknown" } as const;
  }
}

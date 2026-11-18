"use server";

import { getCreditOverview, grantManualCredits, withdrawManualCredits } from "@/src/application/credits/credit-service";
import { requireRole, requireUser } from "@/src/interfaces/auth/session";

export async function getCreditOverviewAction(input?: unknown) {
  const actor = await requireUser();
  return getCreditOverview({ userId: actor.userId, role: actor.role }, input);
}

export async function grantManualCreditsAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return grantManualCredits({ userId: actor.userId, role: actor.role }, input);
}

export async function withdrawManualCreditsAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return withdrawManualCredits({ userId: actor.userId, role: actor.role }, input);
}


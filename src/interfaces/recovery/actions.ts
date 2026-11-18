"use server";

import {
  cancelRecoveryReservation,
  getRecoveryAvailabilityForSession,
  getRecoveryHistory,
  listFutureRecoveryOptions,
  reserveRecovery,
} from "@/src/application/recovery/recovery-service";
import { requireRole, requireUser } from "@/src/interfaces/auth/session";

export async function listFutureRecoveryOptionsAction() {
  const actor = await requireRole("STUDENT");
  return listFutureRecoveryOptions({ userId: actor.userId, role: actor.role });
}

export async function reserveRecoveryAction(input: unknown) {
  const actor = await requireRole("STUDENT");
  return reserveRecovery({ userId: actor.userId, role: actor.role }, input);
}

export async function cancelRecoveryReservationAction(input: unknown) {
  const actor = await requireUser();
  return cancelRecoveryReservation({ userId: actor.userId, role: actor.role }, input);
}

export async function getRecoveryHistoryAction(input?: unknown) {
  const actor = await requireUser();
  return getRecoveryHistory({ userId: actor.userId, role: actor.role }, input);
}

export async function getRecoveryAvailabilityForSessionAction(classSessionId: string) {
  const actor = await requireRole("STUDENT");
  return getRecoveryAvailabilityForSession({ userId: actor.userId, role: actor.role }, classSessionId);
}


"use server";

import {
  addSessionCapacityBlock,
  assignStudentToTemplate,
  cancelClassSession,
  correctAttendance,
  cancelReservation,
  createClassTemplate,
  createOneOffClassSession,
  createReservation,
  createReservationForCurrentStudent,
  createStudentProfile,
  detectAbsences,
  endStudentTemplateAssignment,
  generateClassSessions,
  getClassSessionAvailability,
  getStudentActivityHistory,
  recordAttendance,
  setClassTemplateStatus,
  updateClassSession,
} from "@/src/application/academic/academic-service";
import { requireRole, requireUser } from "@/src/interfaces/auth/session";

export async function createStudentProfileAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return createStudentProfile({ userId: actor.userId, role: actor.role }, input);
}

export async function createClassTemplateAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return createClassTemplate({ userId: actor.userId, role: actor.role }, input);
}

export async function setClassTemplateStatusAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return setClassTemplateStatus({ userId: actor.userId, role: actor.role }, input);
}

export async function generateClassSessionsAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return generateClassSessions({ userId: actor.userId, role: actor.role }, input);
}

export async function createOneOffClassSessionAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return createOneOffClassSession({ userId: actor.userId, role: actor.role }, input);
}

export async function updateClassSessionAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return updateClassSession({ userId: actor.userId, role: actor.role }, input);
}

export async function cancelClassSessionAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return cancelClassSession({ userId: actor.userId, role: actor.role }, input);
}

export async function assignStudentToTemplateAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return assignStudentToTemplate({ userId: actor.userId, role: actor.role }, input);
}

export async function endStudentTemplateAssignmentAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return endStudentTemplateAssignment({ userId: actor.userId, role: actor.role }, input);
}

export async function addSessionCapacityBlockAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return addSessionCapacityBlock({ userId: actor.userId, role: actor.role }, input);
}

export async function getClassSessionAvailabilityAction(classSessionId: string) {
  await requireUser();
  return getClassSessionAvailability(classSessionId);
}

export async function createReservationAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return createReservation({ userId: actor.userId, role: actor.role }, input);
}

export async function createReservationForCurrentStudentAction(classSessionId: string) {
  const actor = await requireRole("STUDENT");
  return createReservationForCurrentStudent({ userId: actor.userId, role: actor.role }, classSessionId);
}

export async function cancelReservationAction(input: unknown) {
  const actor = await requireUser();
  return cancelReservation({ userId: actor.userId, role: actor.role }, input);
}

export async function recordAttendanceAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return recordAttendance({ userId: actor.userId, role: actor.role }, input);
}

export async function correctAttendanceAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return correctAttendance({ userId: actor.userId, role: actor.role }, input);
}

export async function detectAbsencesAction(input: unknown) {
  const actor = await requireRole("SUPER_ADMIN");
  return detectAbsences({ userId: actor.userId, role: actor.role }, input);
}

export async function getStudentActivityHistoryAction(input?: unknown) {
  const actor = await requireUser();
  return getStudentActivityHistory({ userId: actor.userId, role: actor.role }, input);
}

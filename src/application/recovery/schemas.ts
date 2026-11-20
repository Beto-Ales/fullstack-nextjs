import { z } from "zod";

export const reserveRecoverySchema = z.object({
  classSessionId: z.string().uuid("Invalid class session id."),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const cancelRecoverySchema = z.object({
  reservationId: z.string().uuid("Invalid reservation id."),
});

export const recoveryHistorySchema = z.object({
  studentProfileId: z.string().uuid("Invalid student profile id.").optional(),
});

export const recoveryOptionsCursorSchema = z.object({
  startsAtUtc: z.iso.datetime(),
  sessionId: z.string().min(1),
});


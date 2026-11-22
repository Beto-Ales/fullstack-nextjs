import { z } from "zod";

export const creditStudentQuerySchema = z.object({
  studentProfileId: z.string().uuid("Invalid student profile id.").optional(),
});

export const manualCreditAdjustmentSchema = z.object({
  requestId: z.uuid().toLowerCase(),
  studentProfileId: z.uuid().toLowerCase(),
  amount: z.number().int().min(1).max(100),
  reason: z.string().trim().normalize().min(3).max(300),
  classSessionId: z.uuid().toLowerCase().optional(),
});


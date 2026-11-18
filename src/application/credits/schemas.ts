import { z } from "zod";

export const creditStudentQuerySchema = z.object({
  studentProfileId: z.string().uuid("Invalid student profile id.").optional(),
});

export const manualCreditGrantSchema = z.object({
  studentProfileId: z.string().uuid("Invalid student profile id."),
  amount: z.number().int().positive().max(100),
  reason: z.string().min(3).max(300),
  classSessionId: z.string().uuid("Invalid class session id.").optional(),
});

export const manualCreditWithdrawSchema = z.object({
  studentProfileId: z.string().uuid("Invalid student profile id."),
  amount: z.number().int().positive().max(100),
  reason: z.string().min(3).max(300),
  classSessionId: z.string().uuid("Invalid class session id.").optional(),
});


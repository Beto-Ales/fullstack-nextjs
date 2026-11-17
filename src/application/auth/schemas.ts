import { z } from "zod";

import { normalizeEmail } from "@/src/domain/auth/email";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/src/domain/auth/password-policy";

export const loginInputSchema = z.object({
  email: z.string().transform((value) => normalizeEmail(value)).pipe(z.string().email("Email inválido.")),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`)
    .max(PASSWORD_MAX_LENGTH, `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`),
  returnTo: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

export const createSuperAdminInputSchema = z.object({
  email: z.string().transform((value) => normalizeEmail(value)).pipe(z.string().email("Email inválido.")),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`)
    .max(PASSWORD_MAX_LENGTH, `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`),
});

export type CreateSuperAdminInput = z.infer<typeof createSuperAdminInputSchema>;

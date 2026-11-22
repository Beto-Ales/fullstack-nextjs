import { z } from "zod";

import { createStudentProfileSchema } from "@/src/application/academic/schemas";
import { normalizeEmail } from "@/src/domain/auth/email";
import { BCRYPT_MAX_PASSWORD_BYTES, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/src/domain/auth/password-policy";

export const emailSchema = z.string().transform(normalizeEmail).pipe(z.email("Email inválido."));
const passwordSchema = z.string()
  .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres.`);
const newPasswordSchema = passwordSchema.refine(
  (value) => Buffer.byteLength(value, "utf8") <= BCRYPT_MAX_PASSWORD_BYTES,
  `La contraseña nueva no puede superar ${BCRYPT_MAX_PASSWORD_BYTES} bytes.`,
);

export const loginInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  returnTo: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginInputSchema>;

export const createSuperAdminInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type CreateSuperAdminInput = z.infer<typeof createSuperAdminInputSchema>;

export const createStudentAccountSchema = createStudentProfileSchema.pick({ firstName: true, lastName: true }).extend({
  email: emailSchema,
  password: newPasswordSchema,
});

export const changeStudentPasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: newPasswordSchema,
});

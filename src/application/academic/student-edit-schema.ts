import { z } from "zod";

import { createStudentProfileSchema } from "@/src/application/academic/schemas";
import { emailSchema } from "@/src/application/auth/schemas";

const fields = createStudentProfileSchema.shape;
const name = z.string().transform((value) => value.trim().replace(/\s+/g, " ")).refine(
  (value) => !/[\p{Cc}]/u.test(value),
  "Escribe un nombre sin caracteres de control.",
);
const email = emailSchema.pipe(z.string().max(255, "El correo admite hasta 255 caracteres."));
const phone = z.string().trim().max(60, "El teléfono admite hasta 60 caracteres.")
  .refine((value) => !value || /^\+?(?=[ ().-]*\d)[\d ().-]+$/.test(value), "Usa dígitos y, si corresponde, el prefijo internacional.")
  .transform((value) => value.replace(/[ ().-]/g, ""))
  .refine((value) => !value || /^\+?\d{7,15}$/.test(value), "Introduce un teléfono de 7 a 15 dígitos.");

export const studentEditSchema = z.strictObject({
  firstName: name.pipe(fields.firstName),
  lastName: name.pipe(fields.lastName),
  email,
  contactEmail: z.string().trim().pipe(z.union([z.literal(""), email])).transform((value) => value || null),
  contactPhone: phone.transform((value) => value || null),
});

export type StudentEditData = z.output<typeof studentEditSchema>;

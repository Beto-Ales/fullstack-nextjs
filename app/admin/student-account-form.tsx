import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { createStudentAccount } from "@/src/application/auth/auth-service";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/src/domain/auth/password-policy";
import { getPublicErrorMessage } from "@/src/infrastructure/errors";
import { requireRole } from "@/src/interfaces/auth/session";

async function createStudentAccountFormAction(form: FormData) {
  "use server";

  const actor = await requireRole("SUPER_ADMIN");
  try {
    await createStudentAccount(actor, {
      firstName: form.get("firstName"),
      lastName: form.get("lastName"),
      email: form.get("email"),
      password: form.get("password"),
    });
  } catch (error) {
    const message = error instanceof ZodError
      ? "Revisa el nombre, el apellido, el email y la contraseña inicial. La contraseña debe tener al menos 12 caracteres y como máximo 72 bytes."
      : getPublicErrorMessage(error);
    redirect(`/admin?studentAccountError=${encodeURIComponent(message)}`);
  }
  redirect("/admin?studentAccount=created");
}

export function StudentAccountForm({ created, error }: { created: boolean; error?: string }) {
  return (
    <section aria-labelledby="student-account">
      <h2 id="student-account">Dar de alta a un alumno</h2>
      {created && <p role="status">Cuenta de alumno creada.</p>}
      {error && <p role="alert">{error}</p>}
      <form action={createStudentAccountFormAction}>
        <div><label>Nombre <input name="firstName" required maxLength={120} /></label></div>
        <div><label>Apellido <input name="lastName" required maxLength={120} /></label></div>
        <div><label>Email del alumno <input name="email" type="email" required autoComplete="off" /></label></div>
        <div>
          <label>
            Contraseña inicial{" "}
            <input name="password" type="password" autoComplete="new-password" required
              minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} />
          </label>
        </div>
        <button type="submit">Crear cuenta de alumno</button>
      </form>
    </section>
  );
}

import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { changeStudentPassword } from "@/src/application/auth/auth-service";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/src/domain/auth/password-policy";
import { getPublicErrorMessage } from "@/src/infrastructure/errors";
import { clearSessionCookie, requireRole } from "@/src/interfaces/auth/session";

async function changePasswordFormAction(form: FormData) {
  "use server";

  const actor = await requireRole("STUDENT");
  try {
    await changeStudentPassword(actor, {
      currentPassword: form.get("currentPassword"),
      newPassword: form.get("newPassword"),
    });
  } catch (error) {
    const message = error instanceof ZodError
      ? "Revisa las contraseñas. La nueva debe tener al menos 12 caracteres y como máximo 72 bytes."
      : getPublicErrorMessage(error);
    redirect(`/student?passwordError=${encodeURIComponent(message)}`);
  }

  await clearSessionCookie();
  redirect("/login?password=changed");
}

export function ChangePasswordForm({ error }: { error?: string }) {
  return (
    <section aria-labelledby="change-password">
      <h2 id="change-password" tabIndex={-1}>Cambiar contraseña</h2>
      {error && <p role="alert">{error}</p>}
      <form action={changePasswordFormAction}>
        <div>
          <label>
            Contraseña actual{" "}
            <input name="currentPassword" type="password" autoComplete="current-password" required
              maxLength={PASSWORD_MAX_LENGTH} />
          </label>
        </div>
        <div>
          <label>
            Contraseña nueva{" "}
            <input name="newPassword" type="password" autoComplete="new-password" required
              minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} />
          </label>
        </div>
        <button type="submit">Guardar contraseña nueva</button>
      </form>
    </section>
  );
}

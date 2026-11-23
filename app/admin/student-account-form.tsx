import { redirect } from "next/navigation";
import { ActionFeedback } from "@/app/components/action-feedback";
import { PendingSubmit } from "@/app/components/pending-submit";
import { ZodError } from "zod";

import { withdrawStudent } from "@/src/application/academic/student-withdrawal";
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

async function withdrawStudentFormAction(form: FormData) {
  "use server";

  const actor = await requireRole("SUPER_ADMIN");
  let result: Awaited<ReturnType<typeof withdrawStudent>>;
  try {
    result = await withdrawStudent(actor, { studentProfileId: form.get("studentProfileId") });
  } catch (error) {
    const message = error instanceof ZodError ? "Selecciona un alumno." : getPublicErrorMessage(error);
    redirect(`/admin?withdrawalError=${encodeURIComponent(message)}`);
  }
  redirect(result.withdrawn
    ? `/admin?releasedReservations=${result.releasedReservations}&cancelledRecoveries=${result.cancelledRecoveries}`
    : "/admin?withdrawal=already-disabled");
}

export function StudentAccountForm({ created, error }: { created: boolean; error?: string }) {
  return (
    <section aria-labelledby="student-account" className="dashboard-section">
      <h2 id="student-account" tabIndex={-1}>Dar de alta a un alumno</h2>
      <ActionFeedback error={error} confirmation={created ? "Cuenta de alumno creada." : undefined} />
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
        <PendingSubmit label="Crear cuenta de alumno" pendingLabel="Creando cuenta…" />
      </form>
    </section>
  );
}

export function StudentWithdrawalForm({ students, query }: {
  students: { id: string; firstName: string; lastName: string; email: string }[];
  query: Record<string, string | string[] | undefined>;
}) {
  const error = typeof query.withdrawalError === "string" ? query.withdrawalError : undefined;
  const released = typeof query.releasedReservations === "string" && /^\d+$/.test(query.releasedReservations)
    ? Number(query.releasedReservations)
    : undefined;
  const recoveries = typeof query.cancelledRecoveries === "string" && /^\d+$/.test(query.cancelledRecoveries)
    ? Number(query.cancelledRecoveries)
    : undefined;
  const confirmation = released !== undefined && recoveries !== undefined
    ? `Baja registrada. Reservas ordinarias liberadas: ${released}. Recuperaciones canceladas: ${recoveries}.`
    : query.withdrawal === "already-disabled" ? "La cuenta ya estaba desactivada." : undefined;

  return (
    <section aria-labelledby="student-withdrawal" className="dashboard-section">
      <h2 id="student-withdrawal" tabIndex={-1}>Dar de baja a un alumno</h2>
      <p>La baja bloquea el acceso, termina las inscripciones y cancela las reservas ordinarias y las recuperaciones de clases que aún no han empezado.</p>
      <ActionFeedback error={error} confirmation={confirmation} />
      {students.length > 0 ? (
        <form action={withdrawStudentFormAction}>
          <label>
            Alumno que causa baja{" "}
            <select name="studentProfileId" defaultValue="" required>
              <option value="" disabled>Selecciona un alumno</option>
              {students.map(({ id, firstName, lastName, email }) => (
                <option key={id} value={id}>{firstName} {lastName} · {email}</option>
              ))}
            </select>
          </label>{" "}
          <PendingSubmit label="Confirmar baja" pendingLabel="Registrando baja…" />
        </form>
      ) : <p>No hay alumnos activos.</p>}
    </section>
  );
}

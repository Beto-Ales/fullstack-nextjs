import { logoutAction } from "@/src/interfaces/auth/actions/logout";
import { requireRole } from "@/src/interfaces/auth/session";
import { db } from "@/src/infrastructure/db/client";
import { studentProfiles } from "@/src/infrastructure/db/schema";
import { getCreditOverview } from "@/src/application/credits/credit-service";
import { grantManualCreditsAction, withdrawManualCreditsAction } from "@/src/interfaces/credits/actions";
import { redirect } from "next/navigation";
import { getPublicErrorMessage } from "@/src/infrastructure/errors";
import { getRecoveryHistory } from "@/src/application/recovery/recovery-service";

type AdminPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

async function grantCreditsFormAction(formData: FormData) {
  "use server";

  const studentProfileId = String(formData.get("studentProfileId") ?? "");
  const amount = Number(formData.get("amount"));
  const reason = String(formData.get("reason") ?? "");

  try {
    await grantManualCreditsAction({ studentProfileId, amount, reason });
    redirect(`/admin?studentProfileId=${encodeURIComponent(studentProfileId)}`);
  } catch (error) {
    const message = getPublicErrorMessage(error);
    redirect(`/admin?studentProfileId=${encodeURIComponent(studentProfileId)}&error=${encodeURIComponent(message)}`);
  }
}

async function withdrawCreditsFormAction(formData: FormData) {
  "use server";

  const studentProfileId = String(formData.get("studentProfileId") ?? "");
  const amount = Number(formData.get("amount"));
  const reason = String(formData.get("reason") ?? "");

  try {
    await withdrawManualCreditsAction({ studentProfileId, amount, reason });
    redirect(`/admin?studentProfileId=${encodeURIComponent(studentProfileId)}`);
  } catch (error) {
    const message = getPublicErrorMessage(error);
    redirect(`/admin?studentProfileId=${encodeURIComponent(studentProfileId)}&error=${encodeURIComponent(message)}`);
  }
}

export default async function AdminHomePage({ searchParams }: AdminPageProps) {
  const user = await requireRole("SUPER_ADMIN");
  const query = (await searchParams) ?? {};
  const selectedStudentProfileId = typeof query.studentProfileId === "string" ? query.studentProfileId : undefined;
  const errorMessage = typeof query.error === "string" ? query.error : undefined;

  const students = await db
    .select({
      id: studentProfiles.id,
      firstName: studentProfiles.firstName,
      lastName: studentProfiles.lastName,
    })
    .from(studentProfiles)
    .orderBy(studentProfiles.lastName, studentProfiles.firstName);

  const creditOverview = selectedStudentProfileId
    ? await getCreditOverview({ userId: user.userId, role: user.role }, { studentProfileId: selectedStudentProfileId })
    : null;
  const recoveryHistory = selectedStudentProfileId
    ? await getRecoveryHistory({ userId: user.userId, role: user.role }, { studentProfileId: selectedStudentProfileId })
    : null;

  return (
    <main>
      <h1>Área de administración</h1>
      <p>Sesión iniciada como: {user.email}</p>
      <h2>Créditos</h2>
      {errorMessage ? (
        <p role="alert" aria-live="polite">
          {errorMessage}
        </p>
      ) : null}
      <form method="get">
        <label htmlFor="studentProfileId">Alumno</label>
        <select id="studentProfileId" name="studentProfileId" defaultValue={selectedStudentProfileId}>
          <option value="">Seleccionar...</option>
          {students.map((student) => (
            <option key={student.id} value={student.id}>
              {student.lastName}, {student.firstName} ({student.id})
            </option>
          ))}
        </select>
        <button type="submit">Consultar créditos</button>
      </form>

      {creditOverview ? (
        <section>
          <p>Disponibles: {creditOverview.availableCredits}</p>
          <p>Caducados: {creditOverview.expiredCredits}</p>
          <p>Total concedidos: {creditOverview.totalCreditsGranted}</p>

          <h3>Conceder créditos manualmente</h3>
          <form action={grantCreditsFormAction}>
            <input type="hidden" name="studentProfileId" value={creditOverview.studentProfileId} />
            <label htmlFor="grant-amount">Cantidad</label>
            <input id="grant-amount" type="number" name="amount" min={1} required />
            <label htmlFor="grant-reason">Motivo</label>
            <input id="grant-reason" type="text" name="reason" minLength={3} required />
            <button type="submit">Conceder</button>
          </form>

          <h3>Retirar créditos manualmente</h3>
          <form action={withdrawCreditsFormAction}>
            <input type="hidden" name="studentProfileId" value={creditOverview.studentProfileId} />
            <label htmlFor="withdraw-amount">Cantidad</label>
            <input id="withdraw-amount" type="number" name="amount" min={1} required />
            <label htmlFor="withdraw-reason">Motivo</label>
            <input id="withdraw-reason" type="text" name="reason" minLength={3} required />
            <button type="submit">Retirar</button>
          </form>

          <h3>Historial de movimientos</h3>
          <ul>
            {creditOverview.history.map((movement) => (
              <li key={movement.id}>
                {movement.movementType} · +/−{movement.amount} · {movement.createdAt.toISOString()}
                {movement.expiresAt ? ` · caduca ${movement.expiresAt.toISOString()}` : ""}
                {movement.reason ? ` · motivo: ${movement.reason}` : ""}
              </li>
            ))}
          </ul>

          <h3>Recuperaciones del alumno</h3>
          <ul>
            {recoveryHistory?.reservations.map((reservation) => (
              <li key={reservation.reservationId}>
                {reservation.classLocalDate} · {reservation.classStartsAtUtc.toISOString()} · estado: {reservation.status}
              </li>
            ))}
          </ul>
          <h4>Consumos y devoluciones</h4>
          <ul>
            {recoveryHistory?.ledgerRows.map((movement) => (
              <li key={movement.id}>
                {movement.movementType} · reserva: {movement.relatedReservationId ?? "n/a"} · {movement.createdAt.toISOString()} ·
                restaura saldo: {movement.refundRestoredCredit === null ? "n/a" : String(movement.refundRestoredCredit)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <form action={logoutAction}>
        <button type="submit">Cerrar sesión</button>
      </form>
    </main>
  );
}


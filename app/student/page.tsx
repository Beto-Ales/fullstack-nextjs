import { logoutAction } from "@/src/interfaces/auth/actions/logout";
import { requireRole } from "@/src/interfaces/auth/session";
import { getCreditOverview, getNextUsableCreditForActor } from "@/src/application/credits/credit-service";
import {
  cancelRecoveryReservationAction,
  getRecoveryHistoryAction,
  listFutureRecoveryOptionsAction,
  reserveRecoveryAction,
} from "@/src/interfaces/recovery/actions";
import { getPublicErrorMessage } from "@/src/infrastructure/errors";
import { redirect } from "next/navigation";

type StudentHomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

async function reserveRecoveryFormAction(formData: FormData) {
  "use server";

  const classSessionId = String(formData.get("classSessionId") ?? "");
  try {
    await reserveRecoveryAction({ classSessionId });
    redirect("/student?recovery=reserved");
  } catch (error) {
    redirect(`/student?error=${encodeURIComponent(getPublicErrorMessage(error))}`);
  }
}

async function cancelRecoveryFormAction(formData: FormData) {
  "use server";

  const reservationId = String(formData.get("reservationId") ?? "");
  try {
    await cancelRecoveryReservationAction({ reservationId });
    redirect("/student?recovery=cancelled");
  } catch (error) {
    redirect(`/student?error=${encodeURIComponent(getPublicErrorMessage(error))}`);
  }
}

export default async function StudentHomePage({ searchParams }: StudentHomePageProps) {
  const user = await requireRole("STUDENT");
  const query = (await searchParams) ?? {};
  const actionError = typeof query.error === "string" ? query.error : undefined;
  const creditOverview = await getCreditOverview({ userId: user.userId, role: user.role });
  const nextUsableCredit = await getNextUsableCreditForActor({ userId: user.userId, role: user.role });
  const recoveryOptions = await listFutureRecoveryOptionsAction();
  const recoveryHistory = await getRecoveryHistoryAction();

  return (
    <main>
      <h1>Área de alumno</h1>
      <p>Sesión iniciada como: {user.email}</p>
      {actionError ? (
        <p role="alert" aria-live="polite">
          {actionError}
        </p>
      ) : null}
      <h2>Créditos</h2>
      <p>Disponibles: {creditOverview.availableCredits}</p>
      <p>Caducados: {creditOverview.expiredCredits}</p>
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

      <h2>Reservas de recuperación</h2>
      <h3>Clases futuras disponibles</h3>
      <ul>
        {recoveryOptions.sessions.map((session) => (
          <li key={session.id}>
            {session.localDate} · {session.startsAtUtc.toISOString()} · plazas: {session.availableSpots} · cupo mensual:{" "}
            {session.monthlyRecoveryRemaining}
            {nextUsableCredit.nextUsableGrantMovementId ? (
              <p>
                Crédito FIFO estimado: {nextUsableCredit.nextUsableGrantMovementId}
                {nextUsableCredit.nextUsableExpiresAt ? ` (caduca ${nextUsableCredit.nextUsableExpiresAt.toISOString()})` : ""}
              </p>
            ) : (
              <p>Sin créditos utilizables.</p>
            )}
            <form action={reserveRecoveryFormAction}>
              <input type="hidden" name="classSessionId" value={session.id} />
              <button type="submit">Reservar recuperación (consume 1 crédito)</button>
            </form>
          </li>
        ))}
      </ul>

      <h3>Mis recuperaciones</h3>
      <ul>
        {recoveryHistory.reservations.map((reservation) => (
          <li key={reservation.reservationId}>
            {reservation.classLocalDate} · {reservation.classStartsAtUtc.toISOString()} · estado: {reservation.status}
            {reservation.status === "CONFIRMED" ? (
              <form action={cancelRecoveryFormAction}>
                <input type="hidden" name="reservationId" value={reservation.reservationId} />
                <p>Si faltan 7 días o más se devuelve crédito (si no caducó); en otro caso se pierde.</p>
                <button type="submit">Cancelar recuperación</button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>

      <form action={logoutAction}>
        <button type="submit">Cerrar sesión</button>
      </form>
    </main>
  );
}


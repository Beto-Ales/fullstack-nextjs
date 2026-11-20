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
import Link from "next/link";
import { getCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { listUpcomingOrdinaryReservations } from "@/src/application/academic/academic-service";
import { cancelReservationAction } from "@/src/interfaces/academic/actions";
import { ChangePasswordForm } from "./change-password-form";

type StudentHomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

async function cancelClassFormAction(formData: FormData) {
  "use server";

  const reservationId = String(formData.get("reservationId") ?? "");
  try {
    await cancelReservationAction({ reservationId });
  } catch (error) {
    redirect(`/student?error=${encodeURIComponent(getPublicErrorMessage(error))}`);
  }
  redirect("/student?class=cancelled");
}

async function reserveRecoveryFormAction(formData: FormData) {
  "use server";

  const classSessionId = String(formData.get("classSessionId") ?? "");
  try {
    await reserveRecoveryAction({ classSessionId });
  } catch (error) {
    redirect(`/student?error=${encodeURIComponent(getPublicErrorMessage(error))}`);
  }
  redirect("/student?recovery=reserved");
}

async function cancelRecoveryFormAction(formData: FormData) {
  "use server";

  const reservationId = String(formData.get("reservationId") ?? "");
  try {
    await cancelRecoveryReservationAction({ reservationId });
  } catch (error) {
    redirect(`/student?error=${encodeURIComponent(getPublicErrorMessage(error))}`);
  }
  redirect("/student?recovery=cancelled");
}

export default async function StudentHomePage({ searchParams }: StudentHomePageProps) {
  const user = await requireRole("STUDENT");
  const query = (await searchParams) ?? {};
  const actionError = typeof query.error === "string" ? query.error : undefined;
  const confirmation = query.class === "cancelled"
    ? "Clase cancelada."
    : query.recovery === "reserved"
      ? "Recuperación reservada."
      : query.recovery === "cancelled" ? "Recuperación cancelada." : undefined;
  const regulation = await getCurrentAcademicRegulation(user);
  const creditOverview = await getCreditOverview({ userId: user.userId, role: user.role });
  const nextUsableCredit = await getNextUsableCreditForActor({ userId: user.userId, role: user.role });
  const recoveryOptions = await listFutureRecoveryOptionsAction();
  const recoveryHistory = await getRecoveryHistoryAction();
  const upcomingClasses = await listUpcomingOrdinaryReservations(user);

  return (
    <main>
      <h1>Área de alumno</h1>
      <p>Sesión iniciada como: {user.email}</p>
      <p><Link href="/normativa">Consultar la normativa</Link></p>
      <ChangePasswordForm error={typeof query.passwordError === "string" ? query.passwordError : undefined} />
      {actionError ? (
        <p role="alert" aria-live="polite">
          {actionError}
        </p>
      ) : null}
      {confirmation && <p role="status">{confirmation}</p>}
      <section aria-labelledby="upcoming-classes">
        <h2 id="upcoming-classes">Mis próximas clases</h2>
        <ul>
          {upcomingClasses.map((reservation) => (
            <li key={reservation.reservationId}>
              {reservation.localDate} · {reservation.startsAtUtc.toISOString()}
              <form action={cancelClassFormAction}>
                <input type="hidden" name="reservationId" value={reservation.reservationId} />
                <button type="submit">Cancelar clase</button>
              </form>
            </li>
          ))}
        </ul>
      </section>
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
      <section aria-labelledby="available-recoveries">
        <h3 id="available-recoveries">Clases futuras disponibles</h3>
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
      </section>

      <section aria-labelledby="my-recoveries">
        <h3 id="my-recoveries">Mis recuperaciones</h3>
        <ul>
          {recoveryHistory.reservations.map((reservation) => (
            <li key={reservation.reservationId}>
              {reservation.classLocalDate} · {reservation.classStartsAtUtc.toISOString()} · estado: {reservation.status}
              {reservation.status === "CONFIRMED" ? (
                <form action={cancelRecoveryFormAction}>
                  <input type="hidden" name="reservationId" value={reservation.reservationId} />
                  <p>El crédito se devuelve si sigue vigente y cancelas con al menos {regulation.cancellationNoticeDays} días naturales de antelación.</p>
                  <button type="submit">Cancelar recuperación</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <form action={logoutAction}>
        <button type="submit">Cerrar sesión</button>
      </form>
    </main>
  );
}


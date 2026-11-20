import { logoutAction } from "@/src/interfaces/auth/actions/logout";
import { requireRole } from "@/src/interfaces/auth/session";
import { getCreditOverview, getNextUsableCreditForActor } from "@/src/application/credits/credit-service";
import {
  cancelRecoveryReservationAction,
  getRecoveryHistoryAction,
  listFutureRecoveryOptionsAction,
  reserveRecoveryAction,
} from "@/src/interfaces/recovery/actions";
import { getPublicErrorMessage, isApplicationError } from "@/src/infrastructure/errors";
import { redirect } from "next/navigation";
import Link from "next/link";
import { DateTime } from "luxon";
import { z } from "zod";
import { getCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import { listStudentCalendarReservations, listUpcomingOrdinaryReservations } from "@/src/application/academic/academic-service";
import { cancelReservationAction } from "@/src/interfaces/academic/actions";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { ChangePasswordForm } from "./change-password-form";
import { RecoveryOptions } from "./recovery-options";
import { WeeklyCalendar } from "./weekly-calendar";

type StudentHomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function studentResultPath(week: string | null, result: Record<string, string>) {
  const params = new URLSearchParams(result);
  if (week) params.set("week", week);
  return `/student?${params}`;
}

async function cancelClassFormAction(week: string | null, formData: FormData) {
  "use server";

  const reservationId = String(formData.get("reservationId") ?? "");
  try {
    await cancelReservationAction({ reservationId });
  } catch (error) {
    redirect(studentResultPath(week, { error: getPublicErrorMessage(error) }));
  }
  redirect(studentResultPath(week, { class: "cancelled" }));
}

async function reserveRecoveryFormAction(week: string | null, formData: FormData) {
  "use server";

  const classSessionId = String(formData.get("classSessionId") ?? "");
  try {
    await reserveRecoveryAction({ classSessionId });
  } catch (error) {
    const message = isApplicationError(error) && error.code === "no_spots_available"
      ? "La plaza ya no está disponible."
      : getPublicErrorMessage(error);
    redirect(studentResultPath(week, { error: message }));
  }
  redirect(studentResultPath(week, { recovery: "reserved" }));
}

async function cancelRecoveryFormAction(week: string | null, formData: FormData) {
  "use server";

  const reservationId = String(formData.get("reservationId") ?? "");
  try {
    await cancelRecoveryReservationAction({ reservationId });
  } catch (error) {
    redirect(studentResultPath(week, { error: getPublicErrorMessage(error) }));
  }
  redirect(studentResultPath(week, { recovery: "cancelled" }));
}

export default async function StudentHomePage({ searchParams }: StudentHomePageProps) {
  const user = await requireRole("STUDENT");
  const query = (await searchParams) ?? {};
  const requestedWeek = z.iso.date().safeParse(query.week);
  const now = DateTime.now().setZone(CENTER_TIME_ZONE);
  const currentWeek = now.startOf("week");
  const week = requestedWeek.success
    ? DateTime.fromISO(requestedWeek.data, { zone: CENTER_TIME_ZONE }).startOf("week")
    : currentWeek;
  const weekParam = week.equals(currentWeek) ? null : week.toISODate();
  const cancelClass = cancelClassFormAction.bind(null, weekParam);
  const reserveRecovery = reserveRecoveryFormAction.bind(null, weekParam);
  const cancelRecovery = cancelRecoveryFormAction.bind(null, weekParam);
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
  const [upcomingClasses, calendarReservations] = await Promise.all([
    listUpcomingOrdinaryReservations(user),
    listStudentCalendarReservations(user, week.toJSDate(), week.plus({ weeks: 1 }).toJSDate()),
  ]);

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
      <WeeklyCalendar week={week} now={now.toMillis()} reservations={calendarReservations}
        cancelClass={cancelClass} cancelRecovery={cancelRecovery} />
      <section aria-labelledby="upcoming-classes">
        <h2 id="upcoming-classes">Mis próximas clases</h2>
        <ul>
          {upcomingClasses.map((reservation) => (
            <li key={reservation.reservationId}>
              {reservation.localDate} · {reservation.startsAtUtc.toISOString()}
              <form action={cancelClass}>
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
        <RecoveryOptions
          initialPage={recoveryOptions}
          nextGrantId={nextUsableCredit.nextUsableGrantMovementId}
          nextGrantExpiresAt={nextUsableCredit.nextUsableExpiresAt}
          reserveAction={reserveRecovery}
        />
      </section>

      <section aria-labelledby="my-recoveries">
        <h3 id="my-recoveries">Mis recuperaciones</h3>
        <ul>
          {recoveryHistory.reservations.map((reservation) => (
            <li key={reservation.reservationId}>
              {reservation.classLocalDate} · {reservation.classStartsAtUtc.toISOString()} · estado: {reservation.status}
              {reservation.status === "CONFIRMED" ? (
                <form action={cancelRecovery}>
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


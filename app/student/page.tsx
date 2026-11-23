import { logoutAction } from "@/src/interfaces/auth/actions/logout";
import { requireRole } from "@/src/interfaces/auth/session";
import { getCreditOverview } from "@/src/application/credits/credit-service";
import {
  cancelRecoveryReservationAction,
  listFutureRecoveryOptionsAction,
  reserveRecoveryAction,
} from "@/src/interfaces/recovery/actions";
import { getPublicErrorMessage, isApplicationError } from "@/src/infrastructure/errors";
import { redirect } from "next/navigation";
import { DateTime } from "luxon";
import { getCurrentAcademicRegulation } from "@/src/application/academic/regulation-service";
import {
  getStudentCancellationStreak, listStudentCalendarReservations, listStudentClassHistory, listStudentHabitualSchedules, listUpcomingOrdinaryReservations,
} from "@/src/application/academic/academic-service";
import { cancelReservationAction } from "@/src/interfaces/academic/actions";
import { resolveCenterWeek } from "@/src/domain/time/center-week";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { ChangePasswordForm } from "./change-password-form";
import { ClassHistory } from "./class-history";
import { CreditExpirations } from "./credit-expirations";
import { HabitualSchedules } from "./habitual-schedules";
import { RecoveryOptions } from "./recovery-options";
import { WeeklyCalendar } from "./weekly-calendar";
import { ActionFeedback } from "@/app/components/action-feedback";
import { PendingSubmit } from "@/app/components/pending-submit";
import { SectionNavigation } from "@/app/components/section-navigation";
import { HistoryTime } from "@/app/components/history-time";
import { formatCreditMovement, formatCreditQuantity, formatPendingCreditRequests, recoveryReservationLabels } from "@/src/interfaces/presentation/history-format";

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
  const now = DateTime.now().setZone(CENTER_TIME_ZONE);
  const { currentWeek, week } = resolveCenterWeek(query.week, now);
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
  const maximum = regulation.maxEligibleConsecutiveCancellations;
  const streak = maximum === null ? null : await getStudentCancellationStreak(user, maximum);
  const recoveryOptions = await listFutureRecoveryOptionsAction();
  const [upcomingClasses, calendarReservations, habitualSchedules, { history, pendingRecoveries }] = await Promise.all([
    listUpcomingOrdinaryReservations(user),
    listStudentCalendarReservations(user, week.toJSDate(), week.plus({ weeks: 1 }).toJSDate()),
    listStudentHabitualSchedules(user, now.toISODate()!),
    listStudentClassHistory(user, now.toJSDate()),
  ]);

  return (
    <main id="contenido-principal" tabIndex={-1}>
      <h1>Área de alumno</h1>
      <p>Sesión iniciada como: {user.email}</p>
      <SectionNavigation label="Secciones del portal del alumno" policyLabel="Consultar la normativa" sections={[
        { id: "calendario-semanal", label: "Calendario" },
        { id: "upcoming-classes", label: "Próximas clases" },
        { id: "creditos", label: "Créditos" },
        { id: "recuperaciones", label: "Recuperaciones" },
        { id: "class-history-heading", label: "Historial" },
        { id: "change-password", label: "Cambiar contraseña" },
      ]} />
      <form action={logoutAction}>
        <PendingSubmit label="Cerrar sesión" pendingLabel="Cerrando sesión…" />
      </form>
      <ActionFeedback error={actionError} confirmation={confirmation} />
      <WeeklyCalendar week={week} now={now.toMillis()} reservations={calendarReservations}
        cancelClass={cancelClass} cancelRecovery={cancelRecovery} />
      <HabitualSchedules schedules={habitualSchedules} />
      <section aria-labelledby="upcoming-classes" className="dashboard-section">
        <h2 id="upcoming-classes" tabIndex={-1}>Mis próximas clases</h2>
        {upcomingClasses.length === 0 ? <p>No tienes próximas clases reservadas.</p> : <ul>
          {upcomingClasses.map((reservation) => (
            <li key={reservation.reservationId}>
              <HistoryTime value={reservation.startsAtUtc} />
              <form action={cancelClass}>
                <input type="hidden" name="reservationId" value={reservation.reservationId} />
                <PendingSubmit label="Cancelar clase" pendingLabel="Cancelando clase…" />
              </form>
            </li>
          ))}
        </ul>}
      </section>
      <h2 id="creditos" tabIndex={-1}>Créditos</h2>
      {streak && maximum !== null && (
        <section aria-labelledby="racha-de-cancelaciones">
          <h3 id="racha-de-cancelaciones">Racha de cancelaciones habituales</h3>
          <p>Máximo de posiciones elegibles por racha · {maximum}</p>
          {streak.currentIsProvisional
            ? <p>La racha actual está pendiente de resultados de clases anteriores.</p>
            : <p>Cancelaciones consecutivas contabilizadas · {streak.currentConsecutiveCancellations}</p>}
          {!streak.currentIsProvisional && streak.currentConsecutiveCancellations >= maximum && (
            <p>La racha actual alcanzó el máximo. Si continúa, la siguiente cancelación queda fuera del límite por racha.</p>
          )}
          {streak.unresolvedPredecessor
            ? <p>La elegibilidad de una próxima cancelación puede depender de resultados anteriores.</p>
            : streak.currentConsecutiveCancellations < maximum && (
              <p>Si continúa la racha, la próxima cancelación estaría dentro del límite. También se aplican la antelación y el cupo mensual.</p>
            )}
          {streak.pendingCredits > 0 && <p>{formatPendingCreditRequests(streak.pendingCredits)}</p>}
        </section>
      )}
      <p>Disponibles: {formatCreditQuantity(creditOverview.availableCredits)}</p>
      <p>Caducados: {formatCreditQuantity(creditOverview.expiredCredits)}</p>
      <CreditExpirations expirations={creditOverview.availableExpirations} />
      <h3>Historial de movimientos</h3>
      {creditOverview.history.length === 0 ? <p>Todavía no hay movimientos de crédito.</p> : <ul>
        {creditOverview.history.map((movement) => (
          <li key={movement.id}>
            {formatCreditMovement(movement)} · <HistoryTime value={movement.createdAt} />
            {movement.expiresAt && <> · Vencimiento del crédito: <HistoryTime value={movement.expiresAt} /></>}
            {movement.reason ? ` · motivo: ${movement.reason}` : ""}
          </li>
        ))}
      </ul>}

      <h2 id="recuperaciones" tabIndex={-1}>Reservas de recuperación</h2>
      <section aria-labelledby="available-recoveries">
        <h3 id="available-recoveries">Clases futuras disponibles</h3>
        <RecoveryOptions
          initialPage={recoveryOptions}
          hasAvailableCredit={creditOverview.nextUsableGrantMovementId !== null}
          nextGrantExpiresAt={creditOverview.nextUsableExpiresAt}
          reserveAction={reserveRecovery}
        />
      </section>

      <section aria-labelledby="my-recoveries">
        <h3 id="my-recoveries">Mis recuperaciones</h3>
        {pendingRecoveries.length === 0 ? <p>No tienes recuperaciones reservadas.</p> : <ul>
          {pendingRecoveries.map((reservation) => (
            <li key={reservation.reservationId}>
              <HistoryTime value={reservation.startsAtUtc} /> · {recoveryReservationLabels[reservation.status]}
              <form action={cancelRecovery}>
                <input type="hidden" name="reservationId" value={reservation.reservationId} />
                <p>El crédito se devuelve si sigue vigente y cancelas con al menos {regulation.cancellationNoticeDays} días naturales de antelación.</p>
                <PendingSubmit label="Cancelar recuperación" pendingLabel="Cancelando recuperación…" />
              </form>
            </li>
          ))}
        </ul>}
      </section>
      <ClassHistory entries={history} />

      <ChangePasswordForm error={typeof query.passwordError === "string" ? query.passwordError : undefined} />
    </main>
  );
}


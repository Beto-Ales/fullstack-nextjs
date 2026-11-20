import { DateTime } from "luxon";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CalendarTimeRange } from "@/app/components/weekly-calendar";
import { getAdminCalendarSessionDetails } from "@/src/application/academic/admin-calendar-service";
import { resolveCenterWeek } from "@/src/domain/time/center-week";
import { formatInCenterTimeZone } from "@/src/domain/time/timezone";
import { requireRole } from "@/src/interfaces/auth/session";

type SessionEnrollmentsProps = {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const nonEligibilityLabels = {
  TIMING: "Antelación insuficiente",
  SEQUENCE_POSITION: "Posición en la racha de cancelaciones",
  NON_HABITUAL: "Reserva no habitual",
};

export default async function SessionEnrollmentsPage({ params, searchParams }: SessionEnrollmentsProps) {
  const user = await requireRole("SUPER_ADMIN");
  const [{ sessionId }, query] = await Promise.all([params, searchParams]);
  const session = await getAdminCalendarSessionDetails(user, sessionId);
  if (!session) notFound();

  const { week } = resolveCenterWeek(query.week, DateTime.fromJSDate(session.startsAtUtc));

  return (
    <main className="space-y-3">
      <Link className="underline" href={`/admin?week=${week.toISODate()}#calendario-semanal`}>Volver al calendario</Link>
      <h1>Inscritos en {session.name ?? "clase única"}</h1>
      <p>
        <time dateTime={session.startsAtUtc.toISOString()}>
          {formatInCenterTimeZone(session.startsAtUtc, "es-ES", { dateStyle: "full" })}
        </time>
        {" · "}
        <CalendarTimeRange start={session.startsAtUtc} end={session.endsAtUtc} />
        {" · Hora de Copenhague"}
      </p>
      <section aria-labelledby="confirmed-enrollments" className="space-y-2">
        <h2 id="confirmed-enrollments">Reservas confirmadas</h2>
        <p>Total de inscritos: {session.enrollments.length}</p>
        {session.enrollments.length === 0 ? <p>No hay inscritos en esta sesión.</p> : (
          <ul className="space-y-2">
            {session.enrollments.map(({ reservationId, origin, firstName, lastName }) => (
              <li key={reservationId} className="rounded border p-2 wrap-break-word">
                <p>{firstName} {lastName}</p>
                <p>{origin === "MAKEUP" ? "Recuperación" : "Ordinaria"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="session-cancellations" className="space-y-2">
        <h2 id="session-cancellations">Cancelaciones</h2>
        {session.cancellations.length === 0 ? <p>No hay cancelaciones en esta sesión.</p> : (
          <ul className="space-y-2">
            {session.cancellations.map((cancellation) => (
              <li key={cancellation.reservationId} className="rounded border p-2 wrap-break-word">
                <p>{cancellation.firstName} {cancellation.lastName}</p>
                <p>{cancellation.origin === "MAKEUP" ? "Recuperación" : "Ordinaria"}</p>
                <p>{cancellation.cancelledAt ? (
                  <time dateTime={cancellation.cancelledAt.toISOString()}>
                    {formatInCenterTimeZone(cancellation.cancelledAt, "es-ES", { dateStyle: "short", timeStyle: "short" })}
                  </time>
                ) : "Fecha de cancelación sin registrar."}</p>
                {cancellation.cancelledByRole && (
                  <p>{cancellation.cancelledByRole === "SUPER_ADMIN" ? "Por administración" : "Por el alumno"}</p>
                )}
                {cancellation.cancellationType && (
                  <p>{cancellation.cancellationType === "ON_TIME" ? "Con antelación" : "Cancelación tardía"}</p>
                )}
                {cancellation.nonEligibilityReason && (
                  <p>Motivo de no elegibilidad para crédito: {nonEligibilityLabels[cancellation.nonEligibilityReason]}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

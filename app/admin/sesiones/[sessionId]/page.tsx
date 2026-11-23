import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CalendarTimeRange } from "@/app/components/weekly-calendar";
import { getAdminCalendarSessionDetails } from "@/src/application/academic/admin-calendar-service";
import { resolveCenterWeek } from "@/src/domain/time/center-week";
import { formatInCenterTimeZone } from "@/src/domain/time/timezone";
import { requireRole } from "@/src/interfaces/auth/session";

import { submitAttendanceForm } from "./attendance-action";
import { AttendanceForm } from "./attendance-form";
import { SessionCapacityBlocks } from "./capacity-blocks";
import { SessionCapacity } from "./session-capacity";
import { SessionCancellationForm, SessionCancellationPanel } from "./session-cancellation-form";
import { SessionEnrollmentForm } from "./session-enrollment-form";

type SessionEnrollmentsProps = {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const nonEligibilityLabels = {
  TIMING: "Antelación insuficiente",
  SEQUENCE_POSITION: "Posición en la racha de cancelaciones",
  NON_HABITUAL: "Reserva no habitual",
};

const attendanceLabels = { ATTENDED: "Asistió", ABSENT: "Ausente" };

export default async function SessionEnrollmentsPage({ params, searchParams }: SessionEnrollmentsProps) {
  const user = await requireRole("SUPER_ADMIN");
  const [{ sessionId }, query] = await Promise.all([params, searchParams]);
  const now = new Date();
  const session = await getAdminCalendarSessionDetails(user, sessionId, now);
  if (!session) notFound();

  const { week } = resolveCenterWeek(query.week, DateTime.fromJSDate(session.startsAtUtc));
  const cancelled = session.sessionStatus === "CANCELLED";
  const ended = session.endsAtUtc <= now;
  const sessionLabel = `${session.name ?? "Clase única"} · ${formatInCenterTimeZone(session.startsAtUtc, "es-ES", {
    dateStyle: "short", timeStyle: "short",
  })} · Hora de Copenhague`;

  return (
    <main id="contenido-principal" tabIndex={-1} className="space-y-3">
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
      <SessionCapacity capacity={session.capacityOverview}>
        <SessionCapacityBlocks sessionId={sessionId} blocks={session.capacityBlocks} canBlock={session.capacityOverview.reservableSpots > 0} />
      </SessionCapacity>
      <section aria-labelledby="session-enrollment" className="space-y-2 rounded border p-3">
        <h2 id="session-enrollment">Inscribir a un alumno</h2>
        <SessionEnrollmentForm sessionId={sessionId} reservableSpots={session.capacityOverview.reservableSpots} />
      </section>
      <section aria-labelledby="attendance-control" className="space-y-2">
        <h2 id="attendance-control">Control de asistencia</h2>
        {cancelled && <p>La sesión está cancelada. Solo se pueden consultar los registros existentes.</p>}
        {!cancelled && !ended && <p>El registro y la corrección estarán disponibles cuando finalice la clase.</p>}
        <section aria-labelledby="confirmed-enrollments" className="space-y-2">
          <h3 id="confirmed-enrollments" tabIndex={-1}>Reservas confirmadas</h3>
          <p>Total de inscritos: {session.enrollments.length}</p>
          <SessionCancellationPanel sessionId={sessionId}>
            {session.enrollments.length === 0 ? <p>No hay inscritos en esta sesión.</p> : (
              <ul className="space-y-2">
                {session.enrollments.map(({ reservationId, origin, studentProfileId, firstName, lastName, attendanceOutcome }) => {
                  const studentName = `${firstName} ${lastName}`;
                  return (
                    <li key={reservationId} className="rounded border p-3 wrap-break-word">
                      <p className="font-medium">
                        {studentProfileId ? (
                          <Link className="underline" href={`/admin/alumnos/${studentProfileId}?sesion=${sessionId}&week=${week.toISODate()}`} prefetch={false}>
                            {studentName}
                          </Link>
                        ) : studentName}
                      </p>
                      <p>{origin === "MAKEUP" ? "Recuperación" : "Ordinaria"}</p>
                      <p>Estado: <strong>{attendanceOutcome ? attendanceLabels[attendanceOutcome] : "Sin registrar"}</strong></p>
                      {session.capacityOverview.bookingStatus === "UPCOMING" && origin === "ORDINARY" && !attendanceOutcome && reservationId && (
                        <SessionCancellationForm reservationId={reservationId} cancellationId={randomUUID()}
                          studentName={studentName} sessionLabel={sessionLabel} />
                      )}
                      {!cancelled && ended && reservationId && (
                        <AttendanceForm outcome={attendanceOutcome} studentName={studentName}
                          action={submitAttendanceForm.bind(null, sessionId, reservationId, attendanceOutcome !== null)} />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </SessionCancellationPanel>
        </section>
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
                {cancellation.cancellationSource === "ADMIN_DECISION" && (
                  <>
                    <p>Decisión administrativa{cancellation.cancelledByEmail ? ` · ${cancellation.cancelledByEmail}` : ""}</p>
                    <p>Motivo: {cancellation.administrativeReason}</p>
                  </>
                )}
                {cancellation.cancellationSource === "STUDENT_REQUEST" && <p>Solicitada por el alumno</p>}
                {!cancellation.cancellationSource && cancellation.cancelledByRole && (
                  <p>{cancellation.cancelledByRole === "SUPER_ADMIN" ? "Por administración" : "Por el alumno"} · Origen de la decisión sin registrar</p>
                )}
                {cancellation.cancellationSource !== "ADMIN_DECISION" && cancellation.cancellationType && (
                  <p>{cancellation.cancellationType === "ON_TIME" ? "Con antelación" : "Cancelación tardía"}</p>
                )}
                {cancellation.nonEligibilityReason && (
                  <p>Motivo de no elegibilidad para crédito: {nonEligibilityLabels[cancellation.nonEligibilityReason]}</p>
                )}
                {cancellation.attendanceOutcome && (
                  <p>Asistencia histórica: {attendanceLabels[cancellation.attendanceOutcome]}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

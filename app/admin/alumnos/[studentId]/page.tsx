import { DateTime, Info } from "luxon";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  getAdminStudentProfile, type AmbiguousReservationReview, type ProfileClassEntry, type ProfilePageKey,
} from "@/src/application/academic/admin-student-profile-service";
import { regulationDate } from "@/src/application/academic/regulation-service";
import { resolveCenterWeek } from "@/src/domain/time/center-week";
import { CalendarDate, HistoryTime } from "@/app/components/history-time";
import { HistoryText } from "@/app/components/history-text";
import { formatCreditMovement, formatCreditQuantity, formatHistoryInteger } from "@/src/interfaces/presentation/history-format";
import { requireRole } from "@/src/interfaces/auth/session";

import styles from "./profile.module.css";
import { AssignmentCancellationPanel } from "./assignment-cancellation-form";
import { submitStudentEdit } from "./student-edit-action";
import { EditProfileLink, StudentEditForm } from "./student-edit-form";

type StudentProfilePageProps = {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const weekdays = Info.weekdays("long", { locale: "es" });
const editFieldLabels = {
  firstName: "Nombre",
  lastName: "Apellidos",
  email: "Correo de acceso",
  contactEmail: "Correo de contacto",
  contactPhone: "Teléfono de contacto",
};

function auditValueLabel(value: string | null | undefined) {
  if (value === undefined) return "Valor histórico no disponible";
  if (value === null) return "Sin informar";
  if (value === "") return "Campo vacío";
  return value;
}

function ClassDetails({ entry }: { entry: ProfileClassEntry }) {
  return (
    <>
      <p className={styles.label}>{entry.className ?? "Clase única"}</p>
      <p><HistoryTime value={entry.startsAtUtc} /> · {entry.origin === "MAKEUP"
        ? "Recuperación" : entry.habitual ? "Clase habitual" : "Inscripción ordinaria individual"}</p>
    </>
  );
}

function classOutcome(entry: ProfileClassEntry) {
  if (entry.cancellationSource === "ADMIN_DECISION") return "Cancelación por decisión administrativa";
  if (entry.cancellationSource === "STUDENT_REQUEST") {
    if (entry.cancellationType === "ON_TIME") return "Cancelación anticipada del alumno";
    if (entry.cancellationType === "LATE") return "Cancelación tardía del alumno";
    return "Cancelación solicitada por el alumno";
  }
  if (entry.withdrawalCancellation) return "Cancelación por baja de la cuenta";
  if (entry.sessionCancellation) return "Clase cancelada por administración";
  if (entry.cancelled) {
    if (entry.cancellationType === "ON_TIME") return "Cancelación anticipada";
    if (entry.cancellationType === "LATE") return "Cancelación tardía";
    return "Reserva cancelada";
  }
  if (entry.sessionStatus === "CANCELLED") return "Clase cancelada";
  if (entry.attendanceOutcome === "ATTENDED") return "Asistió";
  if (entry.attendanceOutcome === "ABSENT") return "Ausente";
  return "Sin asistencia registrada";
}

function ClassAudit({ entry }: { entry: ProfileClassEntry }) {
  const cancelled = entry.cancelled || entry.sessionStatus === "CANCELLED";
  return (
    <>
      {cancelled && !entry.cancellationSource && !entry.withdrawalCancellation && !entry.sessionCancellation && <p>Origen no determinado</p>}
      {cancelled && (entry.cancelledAt || entry.cancellationActorEmail) && (
        <p>
          {entry.cancelledAt && <>Cancelada el <HistoryTime value={entry.cancelledAt} /></>}
          {entry.cancelledAt && entry.cancellationActorEmail && " · "}
          {entry.cancellationActorEmail && <>Responsable registrado {entry.cancellationActorEmail}</>}
        </p>
      )}
      {entry.administrativeReason && <p>Motivo registrado · {entry.administrativeReason}</p>}
      {entry.attendanceRecordedAt && (
        <p>{entry.attendanceSource === "AUTO" ? "Registro automático" : "Registro manual"} · <HistoryTime value={entry.attendanceRecordedAt} />
          {entry.attendanceActorEmail && <> · {entry.attendanceActorEmail}</>}
        </p>
      )}
      {entry.correctionReason && <p>Motivo de la corrección · {entry.correctionReason}</p>}
    </>
  );
}

function recoveryOutcome(entry: ProfileClassEntry, now: Date) {
  if (entry.cancelled || entry.sessionStatus === "CANCELLED") return `Cancelada · ${classOutcome(entry)}`;
  if (entry.attendanceOutcome === "ATTENDED") return "Realizada · Asistió";
  if (entry.attendanceOutcome === "ABSENT") return "Ausente";
  if (entry.sessionStatus === "COMPLETED" || entry.endsAtUtc <= now) return "Finalizada · Sin asistencia registrada";
  return entry.startsAtUtc > now ? "Futura confirmada" : "En curso";
}

function reviewReservationState(review: AmbiguousReservationReview) {
  if (!review.reservationStatus) return "Estado actual no disponible";
  return review.reservationStatus === "CONFIRMED" ? "Sigue confirmada" : "Cancelada";
}

function reviewSessionState(review: AmbiguousReservationReview, now: Date) {
  if (!review.sessionStatus || !review.endsAtUtc) return null;
  if (review.sessionStatus === "CANCELLED") return "Sesión cancelada";
  if (review.sessionStatus === "COMPLETED" || review.endsAtUtc <= now) return "Sesión finalizada";
  return "Sesión programada";
}

function reviewWeek(startsAtUtc: Date) {
  return resolveCenterWeek(null, DateTime.fromJSDate(startsAtUtc)).week.toISODate();
}

function Pagination({ label, number, hasNext, href }: {
  label: string;
  number: number;
  hasNext: boolean;
  href: (number: number) => string;
}) {
  if (number === 1 && !hasNext) return null;
  return (
    <nav aria-label={`Paginación de ${label}`} className={styles.pagination}>
      {number > 1 && <Link href={href(number - 1)} prefetch={false}>Anterior</Link>}
      <span aria-current="page">Página {number}</span>
      {hasNext && <Link href={href(number + 1)} prefetch={false}>Siguiente</Link>}
    </nav>
  );
}

function ProfileList<T>({ page, empty, render }: {
  page: { items: T[]; number: number };
  empty: string;
  render: (item: T) => ReactNode;
}) {
  if (!page.items.length) return <p>{page.number === 1 ? empty : "No hay registros en esta página."}</p>;
  return <ul className={styles.cards}>{page.items.map(render)}</ul>;
}

export default async function AdminStudentProfilePage({ params, searchParams }: StudentProfilePageProps) {
  const actor = await requireRole("SUPER_ADMIN");
  const [{ studentId }, query] = await Promise.all([params, searchParams]);
  const now = new Date();
  const profile = await getAdminStudentProfile(actor, studentId, query, now);
  if (!profile) notFound();

  const { student, totals, schedules, upcoming, history, recoveries, credits, movements, edits } = profile;
  const localDate = regulationDate(now);
  const studentName = `${student.firstName} ${student.lastName}`;
  const session = z.uuid().safeParse(query.sesion);
  const week = z.iso.date().safeParse(query.week);
  const normalizedWeek = week.success ? resolveCenterWeek(week.data, DateTime.fromJSDate(now)).week.toISODate() : null;
  const context = new URLSearchParams();
  if (normalizedWeek) context.set("week", normalizedWeek);
  const weekSearch = normalizedWeek ? `?${context}` : "";
  const backUrl = session.success
    ? `/admin/sesiones/${session.data}${weekSearch}#confirmed-enrollments`
    : `/admin${weekSearch}#perfiles-de-alumnos`;
  if (session.success) context.set("sesion", session.data);

  const pages = { horarios: schedules.number, proximas: upcoming.number, historial: history.number,
    movimientos: movements.number, recuperaciones: recoveries.number, modificaciones: edits.number };
  for (const [key, number] of Object.entries(pages)) {
    if (number > 1) context.set(key, String(number));
  }
  const profilePath = `/admin/alumnos/${student.id}`;
  const editContext = new URLSearchParams(context);
  editContext.set("editar", "1");
  const editing = query.editar === "1" && student.status === "ACTIVE";
  function pageHref(key: ProfilePageKey, number: number) {
    const next = new URLSearchParams(context);
    if (editing) next.set("editar", "1");
    if (number > 1) next.set(key, String(number));
    else next.delete(key);
    return `/admin/alumnos/${student.id}${next.size ? `?${next}` : ""}#${key}`;
  }

  const indicators = [
    ["Clases asistidas", totals.attended], ["Ausencias registradas", totals.absent],
    ["Cancelaciones del alumno", totals.studentCancellations], ["Cancelaciones administrativas individuales", totals.adminCancellations],
    ["Créditos disponibles", credits.availableCredits], ["Recuperaciones registradas", totals.recoveries],
  ] as const;

  return (
    <main id="contenido-principal" tabIndex={-1} className={styles.profile}>
      <Link href={backUrl} prefetch={false}>{session.success ? "Volver a la sesión" : "Volver a alumnos"}</Link>
      <header>
        <h1>{student.firstName} {student.lastName}</h1>
        <dl className={styles.account}>
          <div><dt>Estado de la cuenta</dt><dd>{student.status === "ACTIVE" ? "Activa" : "Desactivada"}</dd></div>
          <div><dt>Correo de la cuenta</dt><dd>{student.email}</dd></div>
          <div><dt>Fecha de alta</dt><dd><HistoryTime value={student.createdAt} dateOnly /></dd></div>
          {student.deactivatedAt && <div><dt>Fecha de baja</dt><dd><HistoryTime value={student.deactivatedAt} dateOnly /></dd></div>}
          {student.contactEmail && <div><dt>Correo de contacto</dt><dd>{student.contactEmail}</dd></div>}
          {student.contactPhone && <div><dt>Teléfono de contacto</dt><dd>{student.contactPhone}</dd></div>}
        </dl>
        <p>Fechas y horas de Copenhague</p>
        {student.status === "ACTIVE" && !editing && (
          <EditProfileLink href={`${profilePath}?${editContext}#editar-datos`} />
        )}
        <p><a href="#modificaciones">Ver historial de modificaciones</a></p>
      </header>

      {editing && <StudentEditForm
        initial={{ firstName: student.firstName, lastName: student.lastName, email: student.email,
          contactEmail: student.contactEmail, contactPhone: student.contactPhone }}
        action={submitStudentEdit.bind(null, student.id, profile.editVersion)}
        cancelHref={`${profilePath}${context.size ? `?${context}` : ""}#editar-perfil`}
      />}

      <section aria-labelledby="resumen">
        <h2 id="resumen">Resumen académico</h2>
        <dl className={styles.indicators}>
          {indicators.map(([label, value]) => (
            <div className={styles.card} key={label}><dt>{label}</dt><dd>{formatHistoryInteger(value)}</dd></div>
          ))}
        </dl>
        <p>El total administrativo cuenta decisiones individuales documentadas.</p>
      </section>

      <section aria-labelledby="horarios">
        <h2 id="horarios" tabIndex={-1}>Horarios habituales</h2>
        <ProfileList page={schedules} empty="El alumno no tiene horarios habituales asignados." render={(schedule) => (
          <li key={schedule.assignmentId} className={styles.card}>
            <p className={styles.label}>{schedule.courseName}</p>
            <p>{weekdays[schedule.isoWeekday - 1]} · <time>{schedule.startsAtLocalTime.slice(0, 5)}</time></p>
            <p>{schedule.assignmentStatus === "CANCELLED" ? "Asignación anulada"
              : schedule.courseStatus === "INACTIVE" ? "Curso inactivo"
              : !schedule.currentOrUpcoming ? "Vigencia finalizada" : schedule.upcoming ? "Próximo" : "Vigente"}</p>
            {schedule.assignmentStatus === "ENDED" && <p>Asignación cerrada</p>}
            <p>Desde <CalendarDate value={schedule.effectiveFrom} />{schedule.effectiveTo && <> hasta <CalendarDate value={schedule.effectiveTo} /></>}</p>
            {schedule.cancellation && (
              <div className={styles.audit}>
                <p>
                  {schedule.cancellation.source === "ADMIN_INDIVIDUAL"
                    ? "Anulación administrativa individual" : "Anulación por baja de la cuenta"}
                  {" · "}<HistoryTime value={schedule.cancellation.cancelledAt} />
                </p>
                <p>Responsable registrado · {schedule.cancellation.cancelledByEmail ?? "No disponible"}</p>
                <p>Motivo registrado · {schedule.cancellation.reason}</p>
                {schedule.cancellation.cancelledCount > 0 && (
                  <p>
                    Reservas futuras canceladas al anular: {formatHistoryInteger(schedule.cancellation.cancelledCount)}.
                    Dejaron de ocupar plaza sin alterar el aforo de las sesiones.
                  </p>
                )}
                {schedule.cancellation.ambiguousCount > 0 && (
                  <p>
                    Reservas señaladas al anular: {formatHistoryInteger(schedule.cancellation.ambiguousReviews.historicalCount)}.
                    {" "}Reservas que requieren revisión administrativa: {formatHistoryInteger(schedule.cancellation.ambiguousReviews.needsReviewCount)}.
                    No se cancelaron ni se liberaron plazas automáticamente.
                  </p>
                )}
              </div>
            )}
            {schedule.cancellation && schedule.cancellation.ambiguousReviews.items.length > 0 && (
              <section className={styles.review} aria-labelledby={`revision-${schedule.assignmentId}`}>
                <h3 id={`revision-${schedule.assignmentId}`}>Reservas para revisión administrativa</h3>
                <p>
                  Estas reservas se señalaron como posiblemente relacionadas al anular la asignación. Su procedencia
                  habitual no está demostrada. Revísalas individualmente antes de decidir si corresponde realizar alguna
                  cancelación.
                </p>
                <ul className={styles.reviewList}>
                  {schedule.cancellation.ambiguousReviews.items.map((review) => (
                    <li key={review.reservationId}>
                      {review.sessionId && review.startsAtUtc ? (
                        <>
                          <p className={styles.label}>{review.courseName ?? "Clase única"}</p>
                          <p>
                            Fecha actual de la sesión: <HistoryTime value={review.startsAtUtc} /> · Hora de Copenhague
                          </p>
                          <p>Reserva: <strong>{reviewReservationState(review)}</strong></p>
                          {review.reservationStatus === "CANCELLED" && (
                            <p>
                              {review.cancelledAt
                                ? <>Cancelación registrada el <HistoryTime value={review.cancelledAt} /></>
                                : "Cancelación registrada sin fecha"}
                              {review.cancellationSource === "ADMIN_DECISION" && " · Decisión administrativa"}
                              {review.cancellationSource === "STUDENT_REQUEST" && " · Solicitada por el alumno"}
                            </p>
                          )}
                          {reviewSessionState(review, now) && <p>{reviewSessionState(review, now)}</p>}
                          <p>
                            <Link
                              href={`/admin/sesiones/${encodeURIComponent(review.sessionId)}?week=${reviewWeek(review.startsAtUtc)}`}
                              prefetch={false}
                            >
                              Abrir sesión de {review.courseName ?? "clase única"} del <HistoryTime value={review.startsAtUtc} />
                            </Link>
                          </p>
                        </>
                      ) : (
                        <>
                          <p className={styles.label}>Registro no localizado</p>
                          <p>
                            No se pudo consultar el estado actual de este registro. Puede haber sido eliminado o no estar
                            vinculado a este alumno. Revísalo desde el historial académico antes de decidir alguna
                            cancelación.
                          </p>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <AssignmentCancellationPanel
              studentProfileId={student.id}
              assignmentId={schedule.assignmentId}
              studentName={studentName}
              courseName={schedule.courseName}
              effectiveFrom={schedule.effectiveFrom}
              effectiveTo={schedule.effectiveTo}
              canCancel={student.status === "ACTIVE" && schedule.assignmentStatus === "ACTIVE"
                && schedule.assignmentEffectiveFrom > localDate}
            />
          </li>
        )} />
        <Pagination label="horarios habituales" {...schedules} href={(number) => pageHref("horarios", number)} />
      </section>

      <section aria-labelledby="proximas">
        <h2 id="proximas" tabIndex={-1}>Próximas clases</h2>
        <ProfileList page={upcoming} empty="El alumno no tiene próximas clases confirmadas." render={(entry) => (
          <li key={entry.reservationId} className={styles.card}><ClassDetails entry={entry} /><p>Confirmada</p></li>
        )} />
        <Pagination label="próximas clases" {...upcoming} href={(number) => pageHref("proximas", number)} />
      </section>

      <section aria-labelledby="historial">
        <h2 id="historial" tabIndex={-1}>Historial académico</h2>
        <ProfileList page={history} empty="No hay registros en el historial académico." render={(entry) => (
          <li key={entry.reservationId} className={styles.card}>
            <ClassDetails entry={entry} /><p>{classOutcome(entry)}</p><ClassAudit entry={entry} />
          </li>
        )} />
        <Pagination label="historial académico" {...history} href={(number) => pageHref("historial", number)} />
      </section>

      <section aria-labelledby="creditos">
        <h2 id="creditos">Créditos</h2>
        <dl className={styles.indicators}>
          <div className={styles.card}><dt>Disponibles</dt><dd>{formatCreditQuantity(credits.availableCredits)}</dd></div>
          <div className={styles.card}><dt>Utilizados en recuperaciones</dt><dd>{formatCreditQuantity(credits.usedCredits)}</dd></div>
          <div className={styles.card}><dt>Caducados</dt><dd>{formatCreditQuantity(credits.expiredCredits)}</dd></div>
        </dl>
        {credits.pendingExpirationUnits > 0 && (
          <p>Vencimientos pendientes de registro: {formatCreditQuantity(credits.pendingExpirationUnits)}.</p>
        )}
        <h3>Próximos vencimientos</h3>
        {credits.nextExpirations.length ? (
          <ul>
            {credits.nextExpirations.map(({ amount, expiresAt }) => expiresAt && (
              <li key={expiresAt.getTime()}>{formatCreditQuantity(amount)} · <HistoryTime value={expiresAt} /></li>
            ))}
          </ul>
        ) : <p>No hay créditos disponibles con vencimiento programado.</p>}
        {credits.moreExpirations && <p>Se muestran los cinco vencimientos más próximos.</p>}
        <h3 id="movimientos" tabIndex={-1}>Movimientos del ledger</h3>
        <ProfileList page={movements} empty="No hay movimientos de créditos." render={(movement) => (
          <li key={movement.id} className={styles.card}>
            <p className={styles.label}><HistoryText {...formatCreditMovement(movement)} /></p>
            <p><HistoryTime value={movement.createdAt} /></p>
            {movement.reason && <p>Motivo · {movement.reason}</p>}
            {movement.classSessionId && movement.classStartsAt && (
              <Link href={`/admin/sesiones/${movement.classSessionId}`} prefetch={false}>
                {movement.className ?? "Clase única"} · <HistoryTime value={movement.classStartsAt} />
              </Link>
            )}
          </li>
        )} />
        <Pagination label="movimientos del ledger" {...movements} href={(number) => pageHref("movimientos", number)} />
      </section>

      <section aria-labelledby="recuperaciones">
        <h2 id="recuperaciones" tabIndex={-1}>Recuperaciones</h2>
        <ProfileList page={recoveries} empty="El alumno no tiene reservas de recuperación." render={(entry) => (
          <li key={entry.reservationId} className={styles.card}>
            <ClassDetails entry={entry} />
            <p>{recoveryOutcome(entry, now)}</p>
            <ClassAudit entry={entry} />
            {entry.movements.length > 0 && (
              <ul>
                {entry.movements.map((movement) => (
                  <li key={movement.id}><HistoryText {...formatCreditMovement(movement)} /></li>
                ))}
              </ul>
            )}
          </li>
        )} />
        <Pagination label="recuperaciones" {...recoveries} href={(number) => pageHref("recuperaciones", number)} />
      </section>

      <section aria-labelledby="modificaciones">
        <h2 id="modificaciones" tabIndex={-1}>Historial de modificaciones</h2>
        <ProfileList page={edits} empty="El alumno no tiene modificaciones registradas." render={(event) => (
          <li key={event.id} className={styles.card}>
            <h3>{event.operation === "UPDATE_STUDENT_DETAILS" ? "Actualización del perfil" : "Operación no disponible"}</h3>
            <p><HistoryTime value={event.editedAt} /></p>
            <p>Administrador · {event.actorEmail ?? `No disponible (ID ${event.actorId})`}</p>
            {event.changes.length > 0 ? (
              <dl className={styles.account}>
                {event.changes.map(({ field, before, after }) => (
                  <div key={field}>
                    <dt>{editFieldLabels[field]}</dt>
                    <dd>Anterior · {auditValueLabel(before)}</dd>
                    <dd>Nuevo · {auditValueLabel(after)}</dd>
                  </div>
                ))}
              </dl>
            ) : <p>Detalle de los cambios no disponible.</p>}
          </li>
        )} />
        <Pagination label="historial de modificaciones" {...edits} href={(number) => pageHref("modificaciones", number)} />
      </section>
    </main>
  );
}

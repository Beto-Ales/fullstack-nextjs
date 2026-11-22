import { DateTime, Info } from "luxon";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  getAdminStudentProfile, type ProfileClassEntry, type ProfilePageKey,
} from "@/src/application/academic/admin-student-profile-service";
import { resolveCenterWeek } from "@/src/domain/time/center-week";
import { formatInCenterTimeZone } from "@/src/domain/time/timezone";
import { requireRole } from "@/src/interfaces/auth/session";

import styles from "./profile.module.css";
import { submitStudentEdit } from "./student-edit-action";
import { StudentEditForm } from "./student-edit-form";

type StudentProfilePageProps = {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const weekdays = Info.weekdays("long", { locale: "es" });
const movementLabels = {
  AUTO_CANCELLATION_GRANT: "Concesión por cancelación",
  MANUAL_GRANT: "Concesión manual",
  MANUAL_WITHDRAWAL: "Retirada manual",
  EXPIRATION: "Caducidad",
  RECOVERY_CONSUMPTION: "Consumo por recuperación",
  RECOVERY_REFUND: "Devolución de recuperación",
};
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

function Timestamp({ value, dateOnly = false }: { value: Date; dateOnly?: boolean }) {
  return <time dateTime={value.toISOString()}>{formatInCenterTimeZone(value, "es-ES", {
    day: "2-digit", month: "2-digit", year: "numeric",
    ...(!dateOnly && { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
  })}</time>;
}

function LocalDate({ value }: { value: string }) {
  return <time dateTime={value}>{DateTime.fromISO(value, { zone: "UTC" }).toFormat("dd/MM/yyyy")}</time>;
}

function ClassDetails({ entry }: { entry: ProfileClassEntry }) {
  return (
    <>
      <p className={styles.label}>{entry.className ?? "Clase única"}</p>
      <p><Timestamp value={entry.startsAtUtc} /> · {entry.origin === "MAKEUP"
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
          {entry.cancelledAt && <>Cancelada el <Timestamp value={entry.cancelledAt} /></>}
          {entry.cancelledAt && entry.cancellationActorEmail && " · "}
          {entry.cancellationActorEmail && <>Responsable registrado {entry.cancellationActorEmail}</>}
        </p>
      )}
      {entry.administrativeReason && <p>Motivo registrado · {entry.administrativeReason}</p>}
      {entry.attendanceRecordedAt && (
        <p>{entry.attendanceSource === "AUTO" ? "Registro automático" : "Registro manual"} · <Timestamp value={entry.attendanceRecordedAt} />
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
      <span>Página {number}</span>
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
    <main lang="es" className={styles.profile}>
      <Link href={backUrl} prefetch={false}>{session.success ? "Volver a la sesión" : "Volver a alumnos"}</Link>
      <header>
        <h1>{student.firstName} {student.lastName}</h1>
        <dl className={styles.account}>
          <div><dt>Estado de la cuenta</dt><dd>{student.status === "ACTIVE" ? "Activa" : "Desactivada"}</dd></div>
          <div><dt>Correo de la cuenta</dt><dd>{student.email}</dd></div>
          <div><dt>Fecha de alta</dt><dd><Timestamp value={student.createdAt} dateOnly /></dd></div>
          {student.deactivatedAt && <div><dt>Fecha de baja</dt><dd><Timestamp value={student.deactivatedAt} dateOnly /></dd></div>}
          {student.contactEmail && <div><dt>Correo de contacto</dt><dd>{student.contactEmail}</dd></div>}
          {student.contactPhone && <div><dt>Teléfono de contacto</dt><dd>{student.contactPhone}</dd></div>}
        </dl>
        <p>Fechas y horas de Copenhague</p>
        {student.status === "ACTIVE" && !editing && (
          <Link href={`${profilePath}?${editContext}#editar-datos`} prefetch={false}>Editar datos</Link>
        )}
        <p><a href="#modificaciones">Ver historial de modificaciones</a></p>
      </header>

      {editing && <StudentEditForm
        initial={{ firstName: student.firstName, lastName: student.lastName, email: student.email,
          contactEmail: student.contactEmail, contactPhone: student.contactPhone }}
        action={submitStudentEdit.bind(null, student.id, profile.editVersion)}
        cancelHref={`${profilePath}${context.size ? `?${context}` : ""}`}
      />}

      <section aria-labelledby="resumen">
        <h2 id="resumen">Resumen académico</h2>
        <dl className={styles.indicators}>
          {indicators.map(([label, value]) => (
            <div className={styles.card} key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        <p>El total administrativo cuenta decisiones individuales documentadas.</p>
      </section>

      <section aria-labelledby="horarios">
        <h2 id="horarios">Horarios habituales</h2>
        <ProfileList page={schedules} empty="El alumno no tiene horarios habituales asignados." render={(schedule) => (
          <li key={schedule.assignmentId} className={styles.card}>
            <p className={styles.label}>{schedule.courseName}</p>
            <p>{weekdays[schedule.isoWeekday - 1]} · <time>{schedule.startsAtLocalTime.slice(0, 5)}</time></p>
            <p>{schedule.courseStatus === "INACTIVE" ? "Curso inactivo"
              : !schedule.currentOrUpcoming ? "Vigencia finalizada" : schedule.upcoming ? "Próximo" : "Vigente"}</p>
            {schedule.assignmentStatus === "ENDED" && <p>Asignación cerrada</p>}
            <p>Desde <LocalDate value={schedule.effectiveFrom} />{schedule.effectiveTo && <> hasta <LocalDate value={schedule.effectiveTo} /></>}</p>
          </li>
        )} />
        <Pagination label="horarios habituales" {...schedules} href={(number) => pageHref("horarios", number)} />
      </section>

      <section aria-labelledby="proximas">
        <h2 id="proximas">Próximas clases</h2>
        <ProfileList page={upcoming} empty="El alumno no tiene próximas clases confirmadas." render={(entry) => (
          <li key={entry.reservationId} className={styles.card}><ClassDetails entry={entry} /><p>Confirmada</p></li>
        )} />
        <Pagination label="próximas clases" {...upcoming} href={(number) => pageHref("proximas", number)} />
      </section>

      <section aria-labelledby="historial">
        <h2 id="historial">Historial académico</h2>
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
          <div className={styles.card}><dt>Disponibles</dt><dd>{credits.availableCredits}</dd></div>
          <div className={styles.card}><dt>Utilizados en recuperaciones</dt><dd>{credits.usedCredits}</dd></div>
          <div className={styles.card}><dt>Caducados</dt><dd>{credits.expiredCredits}</dd></div>
        </dl>
        {credits.pendingExpirationUnits > 0 && (
          <p>{credits.pendingExpirationUnits} créditos vencidos pendientes de registro en el ledger.</p>
        )}
        <h3>Próximos vencimientos</h3>
        {credits.nextExpirations.length ? (
          <ul>
            {credits.nextExpirations.map(({ amount, expiresAt }) => expiresAt && (
              <li key={expiresAt.toISOString()}>{amount} {amount === 1 ? "crédito" : "créditos"} · <Timestamp value={expiresAt} /></li>
            ))}
          </ul>
        ) : <p>No hay créditos disponibles con vencimiento programado.</p>}
        {credits.moreExpirations && <p>Se muestran los cinco vencimientos más próximos.</p>}
        <h3 id="movimientos">Movimientos del ledger</h3>
        <ProfileList page={movements} empty="No hay movimientos de créditos." render={(movement) => (
          <li key={movement.id} className={styles.card}>
            <p className={styles.label}>{movementLabels[movement.movementType]} · {movement.amount}</p>
            <p><Timestamp value={movement.createdAt} /></p>
            {movement.reason && <p>Motivo · {movement.reason}</p>}
            {movement.classSessionId && movement.classStartsAt && (
              <Link href={`/admin/sesiones/${movement.classSessionId}`} prefetch={false}>
                {movement.className ?? "Clase única"} · <Timestamp value={movement.classStartsAt} />
              </Link>
            )}
            {movement.movementType === "RECOVERY_REFUND" && movement.refundRestoredCredit === false && <p>Devolución sin abono al saldo</p>}
          </li>
        )} />
        <Pagination label="movimientos del ledger" {...movements} href={(number) => pageHref("movimientos", number)} />
      </section>

      <section aria-labelledby="recuperaciones">
        <h2 id="recuperaciones">Recuperaciones</h2>
        <ProfileList page={recoveries} empty="El alumno no tiene reservas de recuperación." render={(entry) => (
          <li key={entry.reservationId} className={styles.card}>
            <ClassDetails entry={entry} />
            <p>{recoveryOutcome(entry, now)}</p>
            <ClassAudit entry={entry} />
            {entry.movements.length > 0 && (
              <ul>
                {entry.movements.map((movement) => (
                  <li key={movement.id}>{movement.movementType === "RECOVERY_CONSUMPTION"
                    ? "Créditos utilizados" : movement.refundRestoredCredit ? "Créditos devueltos" : "Devolución registrada sin abono"}
                    {" · "}{movement.amount}</li>
                ))}
              </ul>
            )}
          </li>
        )} />
        <Pagination label="recuperaciones" {...recoveries} href={(number) => pageHref("recuperaciones", number)} />
      </section>

      <section aria-labelledby="modificaciones">
        <h2 id="modificaciones">Historial de modificaciones</h2>
        <ProfileList page={edits} empty="El alumno no tiene modificaciones registradas." render={(event) => (
          <li key={event.id} className={styles.card}>
            <h3>{event.operation === "UPDATE_STUDENT_DETAILS" ? "Actualización del perfil" : "Operación no disponible"}</h3>
            <p><Timestamp value={event.editedAt} /></p>
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

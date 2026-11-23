import { and, eq, isNull } from "drizzle-orm";
import { DateTime } from "luxon";
import { ZodError } from "zod";
import { logoutAction } from "@/src/interfaces/auth/actions/logout";
import { requireRole } from "@/src/interfaces/auth/session";
import { db } from "@/src/infrastructure/db/client";
import { classSessions, studentProfiles, users } from "@/src/infrastructure/db/schema";
import { createOneOffClassSessionAction } from "@/src/interfaces/academic/actions";
import { getAdminWeeklyOverview } from "@/src/application/academic/admin-calendar-service";
import { DEFAULT_CLASS_CAPACITY } from "@/src/domain/academic/constants";
import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { getCreditOverview } from "@/src/application/credits/credit-service";
import { redirect } from "next/navigation";
import { getPublicErrorMessage } from "@/src/infrastructure/errors";
import { getRecoveryHistory } from "@/src/application/recovery/recovery-service";
import Link from "next/link";
import { ActionFeedback } from "@/app/components/action-feedback";
import { PendingSubmit } from "@/app/components/pending-submit";
import { SectionNavigation } from "@/app/components/section-navigation";
import { HistoryTime } from "@/app/components/history-time";
import { formatCreditMovement, formatCreditQuantity, recoveryReservationLabels } from "@/src/interfaces/presentation/history-format";
import { AdminWeeklyCalendar } from "./weekly-calendar";
import { AdminWeeklySummary } from "./weekly-summary";
import { CourseAdministration } from "./course-administration";
import { ManualCreditForm } from "./manual-credit-form";
import { StudentAccountForm, StudentWithdrawalForm } from "./student-account-form";

type AdminPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

async function createOneOffClassFormAction(formData: FormData) {
  "use server";

  await requireRole("SUPER_ADMIN");
  let classSessionId: string;
  try {
    ({ classSessionId } = await createOneOffClassSessionAction({
      localDate: formData.get("localDate"),
      startsAtLocalTime: formData.get("startsAtLocalTime"),
      durationMinutes: Number(formData.get("durationMinutes")),
      maxCapacity: Number(formData.get("maxCapacity")),
    }));
  } catch (error) {
    const message = error instanceof ZodError
      ? error.issues.some(({ path }) => path[0] === "maxCapacity")
        ? `El aforo debe ser un número entero entre 1 y ${DEFAULT_CLASS_CAPACITY}.`
        : "Revisa la fecha, la hora y la duración de la clase."
      : getPublicErrorMessage(error);
    redirect(`/admin?classCreationError=${encodeURIComponent(message)}`);
  }
  redirect(`/admin?createdClassSession=${encodeURIComponent(classSessionId)}`);
}

export default async function AdminHomePage({ searchParams }: AdminPageProps) {
  const user = await requireRole("SUPER_ADMIN");
  const query = (await searchParams) ?? {};
  const selectedStudentProfileId = typeof query.studentProfileId === "string" ? query.studentProfileId : undefined;
  const classCreationError = typeof query.classCreationError === "string" ? query.classCreationError : undefined;
  const createdClassSessionId = typeof query.createdClassSession === "string" ? query.createdClassSession : undefined;
  const overview = await getAdminWeeklyOverview(user, query.week);
  const { week, sessions: calendarSessions } = overview;
  const capacityLimit = Math.min(overview.capacityLimit, DEFAULT_CLASS_CAPACITY);
  const [createdClass] = createdClassSessionId
    ? await db.select({
      localDate: classSessions.localDate,
      startsAtUtc: classSessions.startsAtUtc,
      endsAtUtc: classSessions.endsAtUtc,
      maxCapacity: classSessions.maxCapacity,
    }).from(classSessions)
      .where(and(eq(classSessions.id, createdClassSessionId), isNull(classSessions.templateId)))
      .limit(1)
    : [];

  const students = await db
    .select({
      id: studentProfiles.id,
      firstName: studentProfiles.firstName,
      lastName: studentProfiles.lastName,
      email: users.email,
      status: users.status,
    })
    .from(studentProfiles)
    .innerJoin(users, eq(users.id, studentProfiles.userId))
    .orderBy(studentProfiles.lastName, studentProfiles.firstName);
  const activeStudents = students.filter(({ status }) => status === "ACTIVE");

  const creditOverview = selectedStudentProfileId
    ? await getCreditOverview({ userId: user.userId, role: user.role }, { studentProfileId: selectedStudentProfileId })
    : null;
  const recoveryHistory = selectedStudentProfileId
    ? await getRecoveryHistory({ userId: user.userId, role: user.role }, { studentProfileId: selectedStudentProfileId })
    : null;

  return (
    <main id="contenido-principal" tabIndex={-1}>
      <h1>Área de administración</h1>
      <p>Sesión iniciada como: {user.email}</p>
      <SectionNavigation label="Secciones del panel administrativo" policyLabel="Consultar y gestionar la normativa" sections={[
        { id: "calendario-semanal", label: "Calendario" },
        { id: "perfiles-de-alumnos", label: "Alumnos" },
        { id: "creditos", label: "Créditos" },
        { id: "one-off-class", label: "Crear clase única" },
        { id: "weekly-course", label: "Crear curso semanal" },
        { id: "enroll-student", label: "Inscribir alumno" },
        { id: "student-account", label: "Dar de alta" },
        { id: "student-withdrawal", label: "Dar de baja" },
      ]} />
      <form action={logoutAction}>
        <PendingSubmit label="Cerrar sesión" pendingLabel="Cerrando sesión…" />
      </form>
      <AdminWeeklyCalendar week={week} sessions={calendarSessions} summary={<AdminWeeklySummary overview={overview} />} />
      <section aria-labelledby="one-off-class" className="dashboard-section">
        <h2 id="one-off-class" tabIndex={-1}>Crear clase única</h2>
        <p>La fecha y la hora se interpretan en la zona de Copenhague.</p>
        <ActionFeedback error={classCreationError} confirmation={createdClass
          ? `Clase única creada para el ${createdClass.localDate} de ${
            DateTime.fromJSDate(createdClass.startsAtUtc, { zone: CENTER_TIME_ZONE }).toFormat("HH:mm")} a ${
            DateTime.fromJSDate(createdClass.endsAtUtc, { zone: CENTER_TIME_ZONE }).toFormat("HH:mm")}. Aforo de ${createdClass.maxCapacity} plazas.`
          : undefined} />
        <form action={createOneOffClassFormAction}>
          <div>
            <label htmlFor="class-local-date">Fecha de la clase</label>{" "}
            <input id="class-local-date" name="localDate" type="date" required />
          </div>
          <div>
            <label htmlFor="class-local-time">Hora de inicio</label>{" "}
            <input id="class-local-time" name="startsAtLocalTime" type="time" required />
          </div>
          <div>
            <label htmlFor="class-duration">Duración (minutos)</label>{" "}
            <input id="class-duration" name="durationMinutes" type="number" min={15} max={360} defaultValue={60} required />
          </div>
          <div>
            <label htmlFor="class-capacity">Aforo</label>{" "}
            <input id="class-capacity" name="maxCapacity" type="number" min={1} max={capacityLimit} defaultValue={capacityLimit} required />
          </div>
          <PendingSubmit label="Guardar clase única" pendingLabel="Guardando clase única…" />
        </form>
      </section>
      <CourseAdministration capacityLimit={capacityLimit} students={activeStudents} query={query} />
      <StudentAccountForm created={query.studentAccount === "created"}
        error={typeof query.studentAccountError === "string" ? query.studentAccountError : undefined} />
      <StudentWithdrawalForm students={activeStudents} query={query} />
      <section aria-labelledby="perfiles-de-alumnos" className="dashboard-section">
        <h2 id="perfiles-de-alumnos" tabIndex={-1}>Perfiles de alumnos</h2>
        {students.length === 0 ? <p>No hay alumnos registrados.</p> : (
          <ul>
            {students.map(({ id, firstName, lastName, email, status }) => (
              <li key={id}>
                <Link href={`/admin/alumnos/${id}?week=${week.toISODate()}`} prefetch={false}>
                  {firstName} {lastName} · {email}
                </Link>
                {status === "DISABLED" && " · Cuenta desactivada"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <h2 id="creditos" tabIndex={-1}>Créditos</h2>
      <form method="get" action="/admin#creditos">
        {typeof query.week === "string" && <input type="hidden" name="week" value={week.toISODate()!} />}
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
          <p>Disponibles: {formatCreditQuantity(creditOverview.availableCredits)}</p>
          <p>Caducados: {formatCreditQuantity(creditOverview.expiredCredits)}</p>
          <p>Total concedidos: {formatCreditQuantity(creditOverview.totalCreditsGranted)}</p>

          {activeStudents.some(({ id }) => id === creditOverview.studentProfileId) ? (
            <>
              <ManualCreditForm key={`grant:${creditOverview.studentProfileId}`} kind="grant"
                studentProfileId={creditOverview.studentProfileId} adminUserId={user.userId} />
              <ManualCreditForm key={`withdraw:${creditOverview.studentProfileId}`} kind="withdraw"
                studentProfileId={creditOverview.studentProfileId} adminUserId={user.userId} />
            </>
          ) : <p>Los ajustes requieren una cuenta de alumno activa.</p>}

          <h3>Historial de movimientos</h3>
          <ul>
            {creditOverview.history.map((movement) => (
              <li key={movement.id}>
                {formatCreditMovement(movement)} · <HistoryTime value={movement.createdAt} />
                {movement.expiresAt && <> · Vencimiento del crédito: <HistoryTime value={movement.expiresAt} /></>}
                {movement.reason ? ` · motivo: ${movement.reason}` : ""}
                {movement.regulationVersionId && (
                  <> · <Link href={`/normativa#version-${movement.regulationVersionId}`}>Normativa aplicada</Link></>
                )}
              </li>
            ))}
          </ul>

          <h3>Recuperaciones del alumno</h3>
          <ul>
            {recoveryHistory?.reservations.map((reservation) => (
              <li key={reservation.reservationId}>
                <HistoryTime value={reservation.classStartsAtUtc} /> · {recoveryReservationLabels[reservation.status]}
                {reservation.regulationVersionId && (
                  <> · <Link href={`/normativa#version-${reservation.regulationVersionId}`}>Normativa de reserva</Link></>
                )}
                {reservation.cancellationRegulationVersionId && (
                  <> · <Link href={`/normativa#version-${reservation.cancellationRegulationVersionId}`}>Normativa de cancelación</Link></>
                )}
              </li>
            ))}
          </ul>
          <h4>Consumos y devoluciones</h4>
          <ul>
            {recoveryHistory?.ledgerRows.map((movement) => (
              <li key={movement.id}>
                {formatCreditMovement(movement)} · <HistoryTime value={movement.createdAt} /> ·{" "}
                Reserva: {movement.relatedReservationId ?? "Sin referencia"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

    </main>
  );
}


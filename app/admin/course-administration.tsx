import { and, eq, gt, gte, isNull, or } from "drizzle-orm";
import { DateTime } from "luxon";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";
import { createWeeklyCourseAction, enrollStudentInAcademicOfferingAction } from "@/src/interfaces/academic/actions";
import { requireRole } from "@/src/interfaces/auth/session";
import { db } from "@/src/infrastructure/db/client";
import { classSessions, classTemplates } from "@/src/infrastructure/db/schema";
import { getPublicErrorMessage } from "@/src/infrastructure/errors";

async function createWeeklyCourseFormAction(form: FormData) {
  "use server";

  await requireRole("SUPER_ADMIN");
  let templateId: string;
  try {
    ({ templateId } = await createWeeklyCourseAction({
      name: form.get("name"),
      firstClassDate: form.get("firstClassDate"),
      startsAtLocalTime: form.get("startsAtLocalTime"),
      durationMinutes: Number(form.get("durationMinutes")),
      maxCapacity: Number(form.get("maxCapacity")),
    }));
  } catch (error) {
    const message = error instanceof ZodError
      ? "Revisa el nombre, la fecha, la hora, la duración y el aforo del curso."
      : getPublicErrorMessage(error);
    redirect(`/admin?courseError=${encodeURIComponent(message)}`);
  }
  redirect(`/admin?createdCourse=${encodeURIComponent(templateId)}`);
}

async function enrollStudentFormAction(form: FormData) {
  "use server";

  await requireRole("SUPER_ADMIN");
  const [targetType, targetId] = String(form.get("offering") ?? "").split(":");
  let reservedSessions: number;
  try {
    ({ reservedSessions } = await enrollStudentInAcademicOfferingAction({
      targetType, targetId, studentProfileId: form.get("studentProfileId"),
    }));
  } catch (error) {
    const message = error instanceof ZodError ? "Selecciona un alumno y una clase o curso." : getPublicErrorMessage(error);
    redirect(`/admin?enrollmentError=${encodeURIComponent(message)}`);
  }
  redirect(`/admin?enrolledSessions=${reservedSessions}`);
}

type CourseAdministrationProps = {
  capacityLimit: number;
  students: { id: string; firstName: string; lastName: string }[];
  query: Record<string, string | string[] | undefined>;
};

export async function CourseAdministration({ capacityLimit, students, query }: CourseAdministrationProps) {
  const now = DateTime.now().setZone(CENTER_TIME_ZONE);
  const today = now.toISODate()!;
  const [courses, oneOffClasses] = await Promise.all([
    db.select({
      id: classTemplates.id,
      name: classTemplates.name,
      effectiveFrom: classTemplates.effectiveFrom,
      effectiveTo: classTemplates.effectiveTo,
    }).from(classTemplates)
      .where(and(eq(classTemplates.status, "ACTIVE"), or(isNull(classTemplates.effectiveTo), gte(classTemplates.effectiveTo, today))))
      .orderBy(classTemplates.effectiveFrom, classTemplates.name),
    db.select({ id: classSessions.id, localDate: classSessions.localDate, startsAtUtc: classSessions.startsAtUtc })
      .from(classSessions)
      .where(and(isNull(classSessions.templateId), eq(classSessions.status, "SCHEDULED"), gt(classSessions.startsAtUtc, now.toJSDate())))
      .orderBy(classSessions.startsAtUtc),
  ]);
  const createdCourse = courses.find(({ id }) => id === query.createdCourse);
  const courseError = typeof query.courseError === "string" ? query.courseError : undefined;
  const enrollmentError = typeof query.enrollmentError === "string" ? query.enrollmentError : undefined;
  const enrolledSessions = typeof query.enrolledSessions === "string" && /^\d+$/.test(query.enrolledSessions)
    ? Number(query.enrolledSessions)
    : undefined;
  const canEnroll = students.length > 0 && courses.length + oneOffClasses.length > 0;

  return (
    <>
      <section aria-labelledby="weekly-course">
        <h2 id="weekly-course">Crear curso semanal</h2>
        <p>Una clase cada semana durante tres meses desde la fecha indicada, en hora de Copenhague.</p>
        {courseError && <p role="alert">{courseError}</p>}
        {createdCourse && (
          <p role="status">Curso {createdCourse.name} creado. Vigencia del {createdCourse.effectiveFrom} al {createdCourse.effectiveTo}.</p>
        )}
        <form action={createWeeklyCourseFormAction}>
          <div>
            <label htmlFor="course-name">Nombre del curso</label>{" "}
            <input id="course-name" name="name" maxLength={150} required />
          </div>
          <div>
            <label htmlFor="course-start-date">Fecha de la primera clase</label>{" "}
            <input id="course-start-date" name="firstClassDate" type="date" required />
          </div>
          <div>
            <label htmlFor="course-start-time">Hora de inicio</label>{" "}
            <input id="course-start-time" name="startsAtLocalTime" type="time" required />
          </div>
          <div>
            <label htmlFor="course-duration">Duración (minutos)</label>{" "}
            <input id="course-duration" name="durationMinutes" type="number" min={15} max={360} defaultValue={60} required />
          </div>
          <div>
            <label htmlFor="course-capacity">Aforo por sesión</label>{" "}
            <input id="course-capacity" name="maxCapacity" type="number" min={1} max={capacityLimit} defaultValue={capacityLimit} required />
          </div>
          <button type="submit">Guardar curso semanal</button>
        </form>
      </section>
      <section aria-labelledby="enroll-student">
        <h2 id="enroll-student">Inscribir alumno</h2>
        {enrollmentError && <p role="alert">{enrollmentError}</p>}
        {enrolledSessions !== undefined && <p role="status">Alumno inscrito. Sesiones reservadas: {enrolledSessions}.</p>}
        {canEnroll ? (
          <form action={enrollStudentFormAction}>
            <div>
              <label htmlFor="enrollment-student">Alumno</label>{" "}
              <select id="enrollment-student" name="studentProfileId" defaultValue="" required>
                <option value="">Selecciona un alumno</option>
                {students.map(({ id, lastName, firstName }) => (
                  <option key={id} value={id}>{lastName}, {firstName}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="enrollment-offering">Curso o clase única</label>{" "}
              <select id="enrollment-offering" name="offering" defaultValue={createdCourse ? `weekly:${createdCourse.id}` : ""} required>
                <option value="">Selecciona un curso o clase</option>
                {courses.length > 0 && <optgroup label="Cursos semanales">
                  {courses.map(({ id, name, effectiveFrom }) => <option key={id} value={`weekly:${id}`}>{name} · {effectiveFrom}</option>)}
                </optgroup>}
                {oneOffClasses.length > 0 && <optgroup label="Clases únicas">
                  {oneOffClasses.map(({ id, localDate, startsAtUtc }) => (
                    <option key={id} value={`one-off:${id}`}>
                      {localDate} · {DateTime.fromJSDate(startsAtUtc, { zone: CENTER_TIME_ZONE }).toFormat("HH:mm")}
                    </option>
                  ))}
                </optgroup>}
              </select>
            </div>
            <button type="submit">Confirmar inscripción</button>
          </form>
        ) : <p>Se necesita un perfil de alumno y un curso abierto o una clase futura.</p>}
      </section>
    </>
  );
}

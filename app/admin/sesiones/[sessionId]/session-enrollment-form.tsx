"use client";

import { useActionState, useState } from "react";

import {
  searchEnrollmentStudents,
  submitSessionEnrollment,
  type StudentSearchState,
} from "./session-enrollment-action";

export function SessionEnrollmentForm({ sessionId, reservableSpots }: { sessionId: string; reservableSpots: number }) {
  const [query, setQuery] = useState("");
  const [search, submitSearch, searching] = useActionState(searchEnrollmentStudents.bind(null, sessionId), { status: "idle" });
  const canEnroll = reservableSpots > 0;

  return (
    <div className="space-y-2">
      <p>Plazas reservables: <strong>{reservableSpots}</strong></p>
      {canEnroll ? (
        <form action={submitSearch}>
          <fieldset disabled={searching} className="grid min-w-0 gap-2 sm:max-w-md">
            <label htmlFor="enrollment-search">Nombre, apellido o correo del alumno</label>
            <input id="enrollment-search" name="query" type="search" required minLength={2} maxLength={120}
              value={query} onChange={(event) => setQuery(event.target.value)} className="w-full min-w-0 rounded border p-2" />
            <button type="submit" className="w-fit rounded border px-3 py-2 disabled:opacity-60">
              {searching ? "Buscando…" : "Buscar alumnos"}
            </button>
          </fieldset>
        </form>
      ) : <p>La inscripción está cerrada para esta sesión.</p>}
      {canEnroll && !searching && search.status === "error" && <p role="alert">{search.message}</p>}
      {canEnroll && !searching && search.status === "results" && (
        <p role="status">
          {search.students.length === 0 ? "No se encontraron alumnos elegibles." : search.hasMore
            ? "Se muestran los primeros 15 resultados. Acota la búsqueda con el nombre completo o el correo."
            : `Alumnos encontrados: ${search.students.length}.`}
        </p>
      )}
      {search.status === "results" && search.students.length > 0 && (
        <EnrollmentConfirmation key={search.students[0].reservationId} sessionId={sessionId}
          students={search.students} canEnroll={canEnroll} searching={searching} />
      )}
    </div>
  );
}

function EnrollmentConfirmation({ sessionId, students, canEnroll, searching }: {
  sessionId: string;
  students: Extract<StudentSearchState, { status: "results" }>["students"];
  canEnroll: boolean;
  searching: boolean;
}) {
  const [state, submit, pending] = useActionState(submitSessionEnrollment.bind(null, sessionId), { status: "idle" });
  const [studentId, setStudentId] = useState("");
  const selected = students.find(({ id }) => id === studentId);

  return (
    <>
      {canEnroll && state.status !== "success" && (
        <form action={submit}>
          <fieldset disabled={pending || searching} className="grid min-w-0 gap-2 sm:max-w-md">
            <label htmlFor="enrollment-student">Alumno para esta sesión</label>
            <select id="enrollment-student" name="studentProfileId" required value={studentId}
              onChange={(event) => setStudentId(event.target.value)} className="w-full min-w-0 rounded border p-2">
              <option value="">Selecciona un alumno</option>
              {students.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
            <input type="hidden" name="reservationId" value={selected?.reservationId ?? ""} />
            <button type="submit" disabled={!selected} className="w-fit rounded border px-3 py-2 disabled:opacity-60">
              {pending ? "Inscribiendo…" : "Confirmar inscripción ordinaria"}
            </button>
          </fieldset>
        </form>
      )}
      <p role="status">{!pending && state.status === "success" ? state.message : ""}</p>
      {!pending && state.status === "error" && <p role="alert">{state.message}</p>}
    </>
  );
}

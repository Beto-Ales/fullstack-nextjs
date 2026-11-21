"use client";

import { useActionState, useId } from "react";

import type { AttendanceFormState } from "./attendance-action";

type AttendanceFormProps = {
  action: (previous: AttendanceFormState, form: FormData) => Promise<AttendanceFormState>;
  outcome: "ATTENDED" | "ABSENT" | null;
  studentName: string;
};

export function AttendanceForm({ action, outcome, studentName }: AttendanceFormProps) {
  const id = useId();
  const [state, submit, pending] = useActionState(action, { status: "idle" });
  const correcting = outcome !== null;
  const newOutcome = outcome === "ATTENDED" ? "ABSENT" : "ATTENDED";

  const form = (
    <form action={submit} className="mt-2">
      <fieldset disabled={pending} className="grid gap-2 sm:max-w-md">
        <legend className="sr-only">{correcting ? "Corrección" : "Registro"} de asistencia de {studentName}</legend>
        <label htmlFor={`${id}-outcome`}>{correcting ? "Nuevo resultado" : "Resultado"}</label>
        <select className="min-w-0 rounded border p-2" id={`${id}-outcome`} name="outcome"
          defaultValue={correcting ? newOutcome : ""} required>
          {!correcting && <option value="" disabled>Selecciona un resultado</option>}
          {outcome !== "ATTENDED" && <option value="ATTENDED">Asistió</option>}
          {outcome !== "ABSENT" && <option value="ABSENT">Ausente</option>}
        </select>
        {correcting && (
          <>
            <label htmlFor={`${id}-reason`}>Motivo de la corrección</label>
            <textarea className="min-w-0 rounded border p-2" id={`${id}-reason`} name="reason" rows={2}
              minLength={3} maxLength={300} required />
          </>
        )}
        <button className="w-fit rounded border px-3 py-2 disabled:opacity-60" type="submit">
          {pending ? "Guardando…" : correcting ? "Guardar corrección" : "Registrar asistencia"}
        </button>
      </fieldset>
    </form>
  );

  return (
    <>
      {correcting ? (
        <details key={outcome} className="mt-2">
          <summary className="w-fit cursor-pointer underline">Corregir asistencia</summary>
          {form}
        </details>
      ) : form}
      <p role="status" className="not-empty:mt-2">{!pending && state.status === "success" ? state.message : ""}</p>
      {!pending && state.status === "error" && <p role="alert" className="mt-2">{state.message}</p>}
    </>
  );
}

"use client";

import { createContext, useActionState, useContext, useId, type ReactNode } from "react";

import { submitSessionCancellation } from "./session-cancellation-action";

const CancellationFormContext = createContext<{ submit: (form: FormData) => void; pending: boolean } | null>(null);

export function SessionCancellationPanel({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [state, submit, pending] = useActionState(submitSessionCancellation.bind(null, sessionId), { status: "idle" });
  return (
    <CancellationFormContext value={{ submit, pending }}>
      <p role="status">{!pending && state.status === "success" ? state.message : ""}</p>
      {!pending && state.status === "error" && <p role="alert">{state.message}</p>}
      {children}
    </CancellationFormContext>
  );
}

export function SessionCancellationForm({ reservationId, cancellationId, studentName, sessionLabel }: {
  reservationId: string;
  cancellationId: string;
  studentName: string;
  sessionLabel: string;
}) {
  const form = useContext(CancellationFormContext);
  const reasonId = useId();
  if (!form) return null;

  return (
    <details className="mt-2">
      <summary className="cursor-pointer underline">Cancelar inscripción</summary>
      <form action={form.submit} className="mt-2">
        <input type="hidden" name="reservationId" value={reservationId} />
        <input type="hidden" name="cancellationId" value={cancellationId} />
        <fieldset disabled={form.pending} className="grid min-w-0 gap-2 sm:max-w-md">
          <legend>Cancelar la reserva ordinaria de {studentName}</legend>
          <p>{sessionLabel}</p>
          <p>Se libera la plaza. El saldo de créditos y la racha del alumno se conservan.</p>
          <label htmlFor={reasonId}>Motivo de la cancelación</label>
          <textarea id={reasonId} name="reason" required minLength={3} maxLength={300} rows={2}
            className="w-full min-w-0 rounded border p-2" />
          <button type="submit" className="w-fit rounded border px-3 py-2 disabled:opacity-60">
            {form.pending ? "Cancelando…" : "Confirmar cancelación"}
          </button>
        </fieldset>
      </form>
    </details>
  );
}

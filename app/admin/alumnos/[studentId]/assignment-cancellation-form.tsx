"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";

import { CalendarDate } from "@/app/components/history-time";
import {
  cancelAssignmentAction, type AssignmentCancellationState,
} from "./assignment-cancellation-action";
import styles from "./profile.module.css";

export function AssignmentCancellationPanel({
  studentProfileId, assignmentId, studentName, courseName, effectiveFrom, effectiveTo, canCancel,
}: {
  studentProfileId: string;
  assignmentId: string;
  studentName: string;
  courseName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  canCancel: boolean;
}) {
  const [state, submit, pending] = useActionState<AssignmentCancellationState, FormData>(
    cancelAssignmentAction.bind(null, studentProfileId, assignmentId),
    { status: "idle" },
  );
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const reason = useRef<HTMLTextAreaElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const reasonError = state.status === "error" ? state.reasonError : undefined;
  const showForm = canCancel && open && state.status !== "success";
  const describedBy = `${reasonId}-help${reasonError ? ` ${reasonId}-error` : ""}`;

  useEffect(() => {
    if (open) {
      reason.current?.focus();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (pending || state.status === "idle") return;
    if (state.status === "error" && state.reasonError) {
      reason.current?.focus();
      return;
    }
    feedback.current?.focus();
  }, [pending, state]);

  function close() {
    restoreFocus.current = true;
    setOpen(false);
  }

  return (
    <div className={styles.cancellation} role="group" aria-label={`Anulación de ${courseName}`}>
      {canCancel && !open && state.status !== "success" && (
        <button ref={trigger} type="button" aria-expanded={false} onClick={() => setOpen(true)}>
          Anular asignación futura
        </button>
      )}
      {showForm && (
        <form action={submit} noValidate aria-busy={pending} className={styles.cancellationForm}>
          <fieldset disabled={pending}>
            <legend>Anular la asignación habitual</legend>
            <p><strong>Alumno:</strong> {studentName}</p>
            <p><strong>Curso habitual:</strong> {courseName}</p>
            <p><strong>Inicio:</strong> <CalendarDate value={effectiveFrom} /></p>
            <p><strong>Fin:</strong> {effectiveTo ? <CalendarDate value={effectiveTo} /> : "Sin fecha de fin"}</p>
            <p>
              Las reservas futuras confirmadas vinculadas a esta asignación se cancelarán automáticamente y dejarán de
              ocupar plaza. Las reservas sin procedencia demostrable se conservarán y quedarán señaladas para revisión
              administrativa.
            </p>
            <p>
              Se conservarán las fechas originales, el historial y el motivo. Esta anulación no modifica el aforo de las
              sesiones ni crea movimientos de crédito.
            </p>
            <div>
              <label htmlFor={reasonId}>Motivo de anulación</label>
              <textarea ref={reason} id={reasonId} name="reason" rows={2} required minLength={3} maxLength={300}
                aria-invalid={reasonError ? true : undefined} aria-describedby={describedBy} />
              <p id={`${reasonId}-help`} className={styles.hint}>
                Entre 3 y 300 caracteres, sin contar los espacios de los extremos.
              </p>
              {reasonError && <p id={`${reasonId}-error`} role="alert">{reasonError}</p>}
            </div>
            <div className={styles.cancellationActions}>
              <button type="submit">{pending ? "Anulando…" : "Confirmar anulación"}</button>
              <button type="button" disabled={pending} onClick={close}>Cancelar y volver</button>
            </div>
          </fieldset>
        </form>
      )}
      {state.status === "success" && (
        <div ref={feedback} role="status" tabIndex={-1}>
          <p>{state.message}</p>
          <dl>
            <div>
              <dt>Reservas futuras canceladas</dt>
              <dd>{state.cancelledReservations}</dd>
            </div>
            <div>
              <dt>Reservas no canceladas automáticamente</dt>
              <dd>{state.ambiguousReservations}</dd>
            </div>
          </dl>
          {state.ambiguousReservations > 0 && (
            <p>
              Las reservas no canceladas automáticamente se conservan confirmadas y requieren revisión administrativa.
            </p>
          )}
          <p>Las reservas canceladas dejan de ocupar plaza sin alterar el aforo de las sesiones.</p>
        </div>
      )}
      {state.status === "error" && !reasonError && (
        <div ref={feedback} role="alert" tabIndex={-1}><p>{state.message}</p></div>
      )}
    </div>
  );
}

"use client";

import { useActionState, useId, useState } from "react";

import type { CapacityBlockFormState } from "./capacity-block-action";

export function CapacityBlockForm({ action, release = false, enabled }: {
  action: (previous: CapacityBlockFormState, form: FormData) => Promise<CapacityBlockFormState>;
  release?: boolean;
  enabled: boolean;
}) {
  const id = useId();
  const [state, submit, pending] = useActionState(action, { status: "idle" });
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {enabled && (
        <div className="mt-2">
          {release ? (
            <button type="button" aria-expanded={expanded} aria-controls={`${id}-form`} className="w-fit underline"
              onClick={() => setExpanded((open) => !open)}>Desbloquear</button>
          ) : <h4>Bloquear una plaza</h4>}
          <form action={submit} id={`${id}-form`} hidden={release && !expanded} className="mt-2">
            <fieldset disabled={pending} className="grid gap-2 sm:max-w-md">
              <label htmlFor={id}>{release ? "Motivo del desbloqueo" : "Motivo del bloqueo"}</label>
              <textarea id={id} name="reason" required minLength={3} maxLength={300} rows={2} className="min-w-0 rounded border p-2" />
              <button type="submit" className="w-fit rounded border px-3 py-2 disabled:opacity-60">
                {pending ? "Guardando…" : release ? "Confirmar desbloqueo" : "Confirmar bloqueo"}
              </button>
            </fieldset>
          </form>
        </div>
      )}
      <p role="status" className="not-empty:mt-2">{!pending && state.status === "success" ? state.message : ""}</p>
      {!pending && state.status === "error" && <p role="alert" className="mt-2">{state.message}</p>}
    </>
  );
}

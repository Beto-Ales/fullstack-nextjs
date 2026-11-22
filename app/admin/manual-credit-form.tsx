"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";

import { submitManualCreditAdjustment } from "./manual-credit-action";

type Props = {
  kind: "grant" | "withdraw";
  studentProfileId: string;
  adminUserId: string;
};

export function ManualCreditForm({ kind, studentProfileId, adminUserId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof submitManualCreditAdjustment>>>();
  const requestId = useRef<string>(null);
  const submitting = useRef(false);
  const storageKey = `manual-credit:${adminUserId}:${studentProfileId}:${kind}`;
  const grant = kind === "grant";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    submitting.current = true;
    startTransition(async () => {
      let response: Awaited<ReturnType<typeof submitManualCreditAdjustment>>;
      try {
        try {
          requestId.current ??= sessionStorage.getItem(storageKey);
        } catch {
          // The in-memory key still supports retries when storage is unavailable.
        }
        requestId.current ??= crypto.randomUUID();
        try {
          sessionStorage.setItem(storageKey, requestId.current);
        } catch {
          // Keep the key in memory until the operation gets a definitive response.
        }
        response = await submitManualCreditAdjustment(kind, studentProfileId, requestId.current, formData);
      } catch {
        setResult({ status: "unknown" });
        return;
      } finally {
        submitting.current = false;
      }
      if (response.status === "success" || response.status === "conflict") {
        requestId.current = null;
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          // The operation already has a definitive response from the server.
        }
      }
      setResult(response);
      if (response.status === "success") {
        form.reset();
        router.refresh();
      }
    });
  }

  const retrying = result?.status === "unknown";
  return (
    <>
      <h3>{grant ? "Conceder créditos manualmente" : "Retirar créditos manualmente"}</h3>
      <form method="post" onSubmit={submit} aria-labelledby={`${kind}-submit`} aria-busy={pending}>
        <label htmlFor={`${kind}-amount`}>Cantidad</label>
        <input id={`${kind}-amount`} type="number" name="amount" min={1} max={100} required readOnly={pending || retrying} />
        <label htmlFor={`${kind}-reason`}>Motivo</label>
        <input id={`${kind}-reason`} type="text" name="reason" minLength={3} maxLength={300} required readOnly={pending || retrying} />
        <button id={`${kind}-submit`} type="submit" disabled={pending}>
          {pending ? "Guardando…" : retrying ? "Reintentar" : grant ? "Conceder" : "Retirar"}
        </button>
        {result?.status === "success" && <p role="status">{grant ? "Concesión de créditos confirmada." : "Retirada de créditos confirmada."}</p>}
        {(result?.status === "error" || result?.status === "conflict") && <p role="alert">{result.message}</p>}
        {retrying && <p role="alert">No se pudo confirmar el resultado. Reintenta esta misma solicitud.</p>}
      </form>
    </>
  );
}

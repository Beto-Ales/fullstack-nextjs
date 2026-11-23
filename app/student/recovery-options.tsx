"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { PendingSubmit } from "@/app/components/pending-submit";
import { listFutureRecoveryOptionsAction } from "@/src/interfaces/recovery/actions";

type RecoveryOptionsPage = Awaited<ReturnType<typeof listFutureRecoveryOptionsAction>>;

type RecoveryOptionsProps = {
  initialPage: RecoveryOptionsPage;
  nextGrantId: string | null;
  nextGrantExpiresAt: Date | null;
  reserveAction: (formData: FormData) => Promise<void>;
};

export function RecoveryOptions({ initialPage, nextGrantId, nextGrantExpiresAt, reserveAction }: RecoveryOptionsProps) {
  const [loaded, setLoaded] = useState<{
    initialPage: RecoveryOptionsPage;
    options: RecoveryOptionsPage;
    firstNewId?: string;
    message?: string;
    error?: string;
  }>();
  const [pending, startTransition] = useTransition();
  const newOption = useRef<HTMLLIElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  // Booking and cancellation render a fresh first page. Discard pages from the previous render.
  const current = loaded?.initialPage === initialPage ? loaded : undefined;
  const options = current?.options ?? initialPage;

  useEffect(() => {
    if (current?.firstNewId) newOption.current?.focus();
    else if (current?.message || current?.error) feedback.current?.focus();
  }, [current]);

  function showMore() {
    const cursor = options.nextCursor;
    if (!cursor || pending) return;

    startTransition(async () => {
      try {
        const next = await listFutureRecoveryOptionsAction(cursor);
        const existingIds = new Set(options.sessions.map(({ id }) => id));
        const newSessions = next.sessions.filter(({ id }) => !existingIds.has(id));
        setLoaded({
          initialPage,
          firstNewId: newSessions[0]?.id,
          message: newSessions.length === 0 ? "No se encontraron más clases disponibles." : undefined,
          options: {
            nextCursor: next.nextCursor,
            sessions: [...options.sessions, ...newSessions],
          },
        });
      } catch {
        setLoaded({ initialPage, options, error: "No se pudieron cargar más clases. Inténtalo de nuevo." });
      }
    });
  }

  return (
    <>
      {options.sessions.length === 0 ? <p>No hay clases de recuperación disponibles.</p> : <ul>
        {options.sessions.map((session) => (
          <li key={session.id} tabIndex={-1} ref={current?.firstNewId === session.id ? newOption : undefined}>
            {session.localDate} · {session.startsAtUtc.toISOString()} · plazas: {session.availableSpots} · cupo mensual:{" "}
            {session.monthlyRecoveryRemaining}
            {nextGrantId ? (
              <p>
                Crédito FIFO estimado: {nextGrantId}
                {nextGrantExpiresAt ? ` (caduca ${nextGrantExpiresAt.toISOString()})` : ""}
              </p>
            ) : (
              <p>Sin créditos utilizables.</p>
            )}
            <form action={reserveAction}>
              <input type="hidden" name="classSessionId" value={session.id} />
              <PendingSubmit label="Reservar recuperación (consume 1 crédito)" pendingLabel="Reservando…" />
            </form>
          </li>
        ))}
      </ul>}
      {options.nextCursor && (
        <button type="button" onClick={showMore} aria-disabled={pending}>
          {pending ? "Cargando clases…" : "Ver más clases"}
        </button>
      )}
      {current?.message && !pending && <p ref={feedback} role="status" tabIndex={-1}>{current.message}</p>}
      {current?.error && !pending && <p ref={feedback} role="alert" tabIndex={-1}>{current.error}</p>}
    </>
  );
}

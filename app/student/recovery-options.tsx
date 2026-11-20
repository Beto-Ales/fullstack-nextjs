"use client";

import { useState, useTransition } from "react";

import { listFutureRecoveryOptionsAction } from "@/src/interfaces/recovery/actions";

type RecoveryOptionsPage = Awaited<ReturnType<typeof listFutureRecoveryOptionsAction>>;

type RecoveryOptionsProps = {
  initialPage: RecoveryOptionsPage;
  nextGrantId: string | null;
  nextGrantExpiresAt: Date | null;
  reserveAction: (formData: FormData) => Promise<void>;
};

export function RecoveryOptions({ initialPage, nextGrantId, nextGrantExpiresAt, reserveAction }: RecoveryOptionsProps) {
  const [loaded, setLoaded] = useState<{ initialPage: RecoveryOptionsPage; options: RecoveryOptionsPage; error?: string }>();
  const [pending, startTransition] = useTransition();
  // Booking and cancellation render a fresh first page. Discard pages from the previous render.
  const current = loaded?.initialPage === initialPage ? loaded : undefined;
  const options = current?.options ?? initialPage;

  function showMore() {
    const cursor = options.nextCursor;
    if (!cursor || pending) return;

    startTransition(async () => {
      try {
        const next = await listFutureRecoveryOptionsAction(cursor);
        const existingIds = new Set(options.sessions.map(({ id }) => id));
        setLoaded({
          initialPage,
          options: {
            nextCursor: next.nextCursor,
            sessions: [...options.sessions, ...next.sessions.filter(({ id }) => !existingIds.has(id))],
          },
        });
      } catch {
        setLoaded({ initialPage, options, error: "No se pudieron cargar más clases. Inténtalo de nuevo." });
      }
    });
  }

  return (
    <>
      <ul>
        {options.sessions.map((session) => (
          <li key={session.id}>
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
              <button type="submit">Reservar recuperación (consume 1 crédito)</button>
            </form>
          </li>
        ))}
      </ul>
      {options.nextCursor && (
        <button type="button" onClick={showMore} disabled={pending}>
          {pending ? "Cargando clases…" : "Ver más clases"}
        </button>
      )}
      {current?.error && !pending && <p role="alert">{current.error}</p>}
    </>
  );
}

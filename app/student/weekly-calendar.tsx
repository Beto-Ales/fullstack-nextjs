import { DateTime } from "luxon";
import Link from "next/link";

import type { listStudentCalendarReservations } from "@/src/application/academic/academic-service";
import { CENTER_TIME_ZONE, formatInCenterTimeZone } from "@/src/domain/time/timezone";

type WeeklyCalendarProps = {
  week: DateTime;
  now: number;
  reservations: Awaited<ReturnType<typeof listStudentCalendarReservations>>;
  cancelClass: (form: FormData) => Promise<void>;
  cancelRecovery: (form: FormData) => Promise<void>;
};

const centerDate = (date: Date) => DateTime.fromJSDate(date, { zone: CENTER_TIME_ZONE });
const calendarTime = (date: Date) => formatInCenterTimeZone(date, "es-ES", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function WeeklyCalendar({ week, now, reservations, cancelClass, cancelRecovery }: WeeklyCalendarProps) {
  const days = new Map<string, WeeklyCalendarProps["reservations"]>();
  for (const reservation of reservations) {
    const day = centerDate(reservation.startsAtUtc).toISODate()!;
    const entries = days.get(day) ?? [];
    entries.push(reservation);
    days.set(day, entries);
  }
  return (
    <section id="calendario-semanal" aria-labelledby="calendar-heading" className="my-4 space-y-3">
      <h2 id="calendar-heading">Calendario semanal</h2>
      <p>
        <time dateTime={week.toISODate()!}>{week.toFormat("dd/MM/yyyy")}</time>
        {" – "}
        {week.plus({ days: 6 }).toFormat("dd/MM/yyyy")} · Hora de Copenhague
      </p>
      <nav aria-label="Navegación del calendario" className="flex flex-wrap gap-2">
        <Link className="rounded border px-2 py-1 underline" prefetch={false}
          href={`/student?week=${week.minus({ weeks: 1 }).toISODate()}#calendario-semanal`}>Semana anterior</Link>
        <Link className="rounded border px-2 py-1 underline" prefetch={false}
          href="/student#calendario-semanal">Semana actual</Link>
        <Link className="rounded border px-2 py-1 underline" prefetch={false}
          href={`/student?week=${week.plus({ weeks: 1 }).toISODate()}#calendario-semanal`}>Semana siguiente</Link>
      </nav>
      {days.size === 0 ? <p>No tienes clases reservadas esta semana.</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from(days, ([day, entries]) => (
            <section key={day} aria-labelledby={`calendar-day-${day}`} className="min-w-0 rounded border p-3">
              <h3 id={`calendar-day-${day}`} className="font-semibold">
                <time dateTime={day}>
                  {centerDate(entries[0].startsAtUtc).setLocale("es").toFormat("cccc, d 'de' MMMM")}
                </time>
              </h3>
              <ul className="mt-2 space-y-2">
                {entries.map((reservation) => {
                  const makeup = reservation.origin === "MAKEUP";
                  const crossesMidnight = !centerDate(reservation.endsAtUtc).hasSame(centerDate(reservation.startsAtUtc), "day");
                  return (
                    <li key={reservation.reservationId} className="wrap-break-word">
                      <p className="font-medium">{reservation.className ?? "Clase única"}</p>
                      <p>{makeup ? "Recuperación" : reservation.habitual ? "Clase habitual" : "Clase ordinaria"}</p>
                      <p>
                        <time dateTime={reservation.startsAtUtc.toISOString()}>{calendarTime(reservation.startsAtUtc)}</time>
                        {"–"}
                        <time dateTime={reservation.endsAtUtc.toISOString()}>
                          {calendarTime(reservation.endsAtUtc)}
                          {crossesMidnight && ` (${centerDate(reservation.endsAtUtc).toFormat("dd/MM")})`}
                        </time>
                      </p>
                      {reservation.sessionStatus === "SCHEDULED" && reservation.startsAtUtc.getTime() > now && (
                        <form action={makeup ? cancelRecovery : cancelClass}>
                          <input type="hidden" name="reservationId" value={reservation.reservationId} />
                          <button type="submit" className="underline">
                            {makeup ? "Cancelar recuperación" : "Cancelar clase"}
                          </button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

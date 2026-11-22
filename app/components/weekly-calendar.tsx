import { DateTime } from "luxon";
import Link from "next/link";
import type { ReactNode } from "react";

import { CENTER_TIME_ZONE, formatInCenterTimeZone } from "@/src/domain/time/timezone";

const centerDate = (date: Date) => DateTime.fromJSDate(date, { zone: CENTER_TIME_ZONE });
const calendarTime = (date: Date) => formatInCenterTimeZone(date, "es-ES", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function CalendarTimeRange({ start, end }: { start: Date; end: Date }) {
  const endDate = centerDate(end);
  return (
    <>
      <time dateTime={start.toISOString()}>{calendarTime(start)}</time>
      {"–"}
      <time dateTime={end.toISOString()}>
        {calendarTime(end)}
        {!endDate.hasSame(centerDate(start), "day") && ` (${endDate.toFormat("dd/MM")})`}
      </time>
    </>
  );
}

type WeeklyCalendarLayoutProps<Entry> = {
  route: "/student" | "/admin";
  title: string;
  emptyMessage: string;
  week: DateTime;
  entries: Entry[];
  entryKey: (entry: Entry) => string;
  renderEntry: (entry: Entry) => ReactNode;
  summary?: ReactNode;
};

export function WeeklyCalendarLayout<Entry extends { startsAtUtc: Date }>({
  route, title, emptyMessage, week, entries, entryKey, renderEntry, summary,
}: WeeklyCalendarLayoutProps<Entry>) {
  const days = new Map<string, Entry[]>();
  for (const entry of entries) {
    const day = centerDate(entry.startsAtUtc).toISODate()!;
    const group = days.get(day) ?? [];
    group.push(entry);
    days.set(day, group);
  }

  return (
    <section id="calendario-semanal" aria-labelledby="calendar-heading" className="my-4 space-y-3">
      <h2 id="calendar-heading">{title}</h2>
      <p>
        <time dateTime={week.toISODate()!}>{week.toFormat("dd/MM/yyyy")}</time>
        {" – "}
        {week.plus({ days: 6 }).toFormat("dd/MM/yyyy")} · Hora de Copenhague
      </p>
      <nav aria-label="Navegación del calendario" className="flex flex-wrap gap-2">
        <Link className="rounded border px-2 py-1 underline" prefetch={false}
          href={`${route}?week=${week.minus({ weeks: 1 }).toISODate()}#calendario-semanal`}>Semana anterior</Link>
        <Link className="rounded border px-2 py-1 underline" prefetch={false}
          href={`${route}#calendario-semanal`}>Semana actual</Link>
        <Link className="rounded border px-2 py-1 underline" prefetch={false}
          href={`${route}?week=${week.plus({ weeks: 1 }).toISODate()}#calendario-semanal`}>Semana siguiente</Link>
      </nav>
      {summary}
      {days.size === 0 ? <p>{emptyMessage}</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from(days, ([day, group]) => (
            <section key={day} aria-labelledby={`calendar-day-${day}`} className="min-w-0 rounded border p-3">
              <h3 id={`calendar-day-${day}`} className="font-semibold">
                <time dateTime={day}>
                  {centerDate(group[0].startsAtUtc).setLocale("es").toFormat("cccc, d 'de' MMMM")}
                </time>
              </h3>
              <ul className="mt-2 space-y-2">
                {group.map((entry) => (
                  <li key={entryKey(entry)} className="wrap-break-word">{renderEntry(entry)}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

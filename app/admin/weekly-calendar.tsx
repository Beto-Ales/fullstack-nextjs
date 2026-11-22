import type { DateTime } from "luxon";
import Link from "next/link";
import type { ReactNode } from "react";

import { CalendarTimeRange, WeeklyCalendarLayout } from "@/app/components/weekly-calendar";
import type { listAdminCalendarSessions } from "@/src/application/academic/admin-calendar-service";

type AdminWeeklyCalendarProps = {
  week: DateTime;
  sessions: Awaited<ReturnType<typeof listAdminCalendarSessions>>;
  summary: ReactNode;
};

const statuses = {
  UPCOMING: "Programada",
  IN_PROGRESS: "En curso",
  CANCELLED: "Cancelada",
  COMPLETED: "Finalizada",
};

export function AdminWeeklyCalendar({ week, sessions, summary }: AdminWeeklyCalendarProps) {
  return (
    <WeeklyCalendarLayout
      route="/admin"
      title="Calendario semanal global"
      emptyMessage="No hay sesiones en esta semana."
      week={week}
      entries={sessions}
      summary={summary}
      entryKey={(session) => session.id}
      renderEntry={(session) => (
        <div className="space-y-1 border-b pb-2">
          <p className="font-medium">{session.name ?? "Clase única"}</p>
          <p>
            <CalendarTimeRange start={session.startsAtUtc} end={session.endsAtUtc} />
            {" · "}{statuses[session.bookingStatus]}
          </p>
          <dl className="grid grid-cols-2 gap-x-2 text-sm">
            <dt>Aforo efectivo</dt><dd>{session.capacity}</dd>
            <dt>Reservas confirmadas</dt><dd>{session.confirmedReservations}</dd>
            <dt>Bloqueos activos</dt><dd>{session.blockedSpots}</dd>
            <dt>Plazas reservables</dt><dd>{session.reservableSpots}</dd>
            {session.habitualPending !== null && (
              <><dt>Habituales pendientes de reserva</dt><dd>{session.habitualPending}</dd></>
            )}
          </dl>
          <p>Capacidad física · {session.physicalCapacity} · Plazas físicamente libres · {session.physicallyFreeSpots}</p>
          {session.capacityConflict && <p className="font-semibold">Los habituales pendientes superan las plazas libres.</p>}
          {session.capacityExcess > 0 && <p className="font-semibold">El aforo efectivo está superado.</p>}
          <Link className="underline" prefetch={false}
            href={`/admin/sesiones/${encodeURIComponent(session.id)}?week=${week.toISODate()}`}>Ver inscritos</Link>
        </div>
      )}
    />
  );
}

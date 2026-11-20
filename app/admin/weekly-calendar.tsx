import type { DateTime } from "luxon";

import { CalendarTimeRange, WeeklyCalendarLayout } from "@/app/components/weekly-calendar";
import type { listAdminCalendarSessions } from "@/src/application/academic/admin-calendar-service";

type AdminWeeklyCalendarProps = {
  week: DateTime;
  sessions: Awaited<ReturnType<typeof listAdminCalendarSessions>>;
};

const statuses = {
  SCHEDULED: "Programada",
  CANCELLED: "Cancelada",
  COMPLETED: "Finalizada",
};

export function AdminWeeklyCalendar({ week, sessions }: AdminWeeklyCalendarProps) {
  return (
    <WeeklyCalendarLayout
      route="/admin"
      title="Calendario semanal global"
      emptyMessage="No hay sesiones en esta semana."
      week={week}
      entries={sessions}
      entryKey={(session) => session.id}
      renderEntry={(session) => (
        <div className="space-y-1 border-b pb-2">
          <p className="font-medium">{session.name ?? "Clase única"}</p>
          <p>
            <CalendarTimeRange start={session.startsAtUtc} end={session.endsAtUtc} />
            {" · "}{statuses[session.sessionStatus]}
          </p>
          <dl className="grid grid-cols-2 gap-x-2 text-sm">
            <dt>Aforo efectivo</dt><dd>{session.capacity}</dd>
            <dt>Reservas confirmadas</dt><dd>{session.confirmedReservations}</dd>
            <dt>Bloqueos activos</dt><dd>{session.blockedSpots}</dd>
            <dt>Plazas libres</dt><dd>{session.availableSpots}</dd>
            {session.habitualPending !== null && (
              <><dt>Habituales pendientes de reserva</dt><dd>{session.habitualPending}</dd></>
            )}
          </dl>
          {session.capacityConflict && <p className="font-semibold">Los habituales pendientes superan las plazas libres.</p>}
        </div>
      )}
    />
  );
}

import type { DateTime } from "luxon";

import { CalendarTimeRange, WeeklyCalendarLayout } from "@/app/components/weekly-calendar";
import { PendingSubmit } from "@/app/components/pending-submit";
import type { listStudentCalendarReservations } from "@/src/application/academic/academic-service";

type WeeklyCalendarProps = {
  week: DateTime;
  now: number;
  reservations: Awaited<ReturnType<typeof listStudentCalendarReservations>>;
  cancelClass: (form: FormData) => Promise<void>;
  cancelRecovery: (form: FormData) => Promise<void>;
};

export function WeeklyCalendar({ week, now, reservations, cancelClass, cancelRecovery }: WeeklyCalendarProps) {
  return (
    <WeeklyCalendarLayout
      route="/student"
      title="Calendario semanal"
      emptyMessage="No tienes clases reservadas esta semana."
      week={week}
      entries={reservations}
      entryKey={(reservation) => reservation.reservationId}
      renderEntry={(reservation) => {
        const makeup = reservation.origin === "MAKEUP";
        return (
          <>
            <p className="font-medium">{reservation.className ?? "Clase única"}</p>
            <p>{makeup ? "Recuperación" : reservation.habitual ? "Clase habitual" : "Clase ordinaria"}</p>
            <p><CalendarTimeRange start={reservation.startsAtUtc} end={reservation.endsAtUtc} /></p>
            {reservation.sessionStatus === "SCHEDULED" && reservation.startsAtUtc.getTime() > now && (
              <form action={makeup ? cancelRecovery : cancelClass}>
                <input type="hidden" name="reservationId" value={reservation.reservationId} />
                <PendingSubmit label={makeup ? "Cancelar recuperación" : "Cancelar clase"}
                  pendingLabel="Cancelando…" className="underline" />
              </form>
            )}
          </>
        );
      }}
    />
  );
}

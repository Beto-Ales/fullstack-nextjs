import { DateTime, Info } from "luxon";

import { CalendarDate } from "@/app/components/history-time";
import type { listStudentHabitualSchedules } from "@/src/application/academic/academic-service";

type HabitualSchedulesProps = {
  schedules: Awaited<ReturnType<typeof listStudentHabitualSchedules>>;
};

const weekdays = Info.weekdays("long", { locale: "es" });

export function HabitualSchedules({ schedules }: HabitualSchedulesProps) {
  return (
    <section aria-labelledby="habitual-schedules" className="my-4 space-y-3">
      <h2 id="habitual-schedules">Horarios habituales</h2>
      {schedules.length === 0 ? <p>No tienes horarios habituales vigentes ni próximos.</p> : (
        <>
          <p>Hora de Copenhague</p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {schedules.map((schedule) => {
              // Add the duration on a fixed clock without applying a particular week's DST transition.
              const start = DateTime.fromISO(`${schedule.effectiveFrom}T${schedule.startsAtLocalTime}`, { zone: "UTC" });
              const end = start.plus({ minutes: schedule.durationMinutes });
              return (
                <li key={schedule.assignmentId} className="min-w-0 rounded border p-3 wrap-break-word">
                  <p className="font-semibold">{schedule.courseName}</p>
                  <p>
                    {weekdays[schedule.isoWeekday - 1]} · <time dateTime={start.toFormat("HH:mm")}>{start.toFormat("HH:mm")}</time>
                    {"–"}
                    <time dateTime={end.toFormat("HH:mm")}>{end.toFormat("HH:mm")}</time>
                    {!end.hasSame(start, "day") && " (día siguiente)"}
                  </p>
                  <p>
                    {schedule.upcoming ? "Próximo" : "Vigente"} · Desde{" "}
                    <CalendarDate value={schedule.effectiveFrom} />
                    {schedule.effectiveTo && (
                      <> hasta <CalendarDate value={schedule.effectiveTo} /></>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

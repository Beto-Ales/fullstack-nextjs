import type { getAdminWeeklyOverview } from "@/src/application/academic/admin-calendar-service";

import styles from "./weekly-summary.module.css";

type WeeklyOverview = Awaited<ReturnType<typeof getAdminWeeklyOverview>>;

function Metrics({ items }: { items: [string, number][] }) {
  return (
    <dl className={styles.metrics}>
      {items.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

export function AdminWeeklySummary({ overview }: { overview: WeeklyOverview }) {
  const { sessionCounts: sessions, activity, capacity } = overview;
  const results = activity.attended + activity.absent;
  const rate = new Intl.NumberFormat("es-ES", { style: "percent", maximumFractionDigits: 1 });
  return (
    <section lang="es" aria-labelledby="weekly-summary" className={styles.summary}>
      <h3 id="weekly-summary">Resumen semanal</h3>
      {overview.sessions.length === 0 ? <p>Sin actividad académica en esta semana.</p> : (
        <div className={styles.groups}>
          <section aria-labelledby="weekly-sessions">
            <h4 id="weekly-sessions">Sesiones</h4>
            <Metrics items={[
              ["Programadas sin cancelar", sessions.scheduled], ["Futuras", sessions.future],
              ["En curso", sessions.inProgress], ["Finalizadas", sessions.finished], ["Canceladas", sessions.cancelled],
            ]} />
          </section>
          <section aria-labelledby="weekly-attendance">
            <h4 id="weekly-attendance">Asistencia en sesiones finalizadas</h4>
            <Metrics items={[
              ["Asistencias registradas", activity.attended], ["Ausencias registradas", activity.absent],
              ["Reservas pendientes de asistencia", activity.pending], ["Resultados registrados", results],
            ]} />
            {results ? <p>Asistencia sobre resultados registrados · {activity.attended} de {results} ({rate.format(activity.attended / results)})</p>
              : <p>Asistencia sobre resultados registrados · Sin datos suficientes</p>}
            {activity.pending > 0 && <p>Resultado provisional mientras queden reservas pendientes.</p>}
          </section>
          <section aria-labelledby="weekly-cancellations">
            <h4 id="weekly-cancellations">Cancelaciones por origen</h4>
            <p>Agrupadas por fecha de la sesión afectada.</p>
            <Metrics items={[
              ["Anticipadas del alumno", activity.early], ["Tardías del alumno", activity.late],
              ["Del alumno sin antelación registrada", activity.studentWithoutTiming],
              ["Decisiones administrativas individuales", activity.administrative],
              ["Otros motivos documentados", activity.other], ["Origen no determinado", activity.unknown],
            ]} />
          </section>
          <section aria-labelledby="weekly-capacity">
            <h4 id="weekly-capacity">Ocupación y disponibilidad</h4>
            <p>Estado actual de las sesiones abiertas a reserva por horario y estado.</p>
            <Metrics items={[
              ["Capacidad física", capacity.physical], ["Aforo efectivo", capacity.effective],
              ["Reservas confirmadas", capacity.confirmed], ["Plazas bloqueadas activas", capacity.blocked],
              ["Plazas físicamente libres", capacity.physicallyFree], ["Plazas reservables", capacity.reservable],
              ["Habituales pendientes de reserva", capacity.habitualPending],
              ["Sesiones con incidencias en la semana", sessions.incidents],
            ]} />
          </section>
        </div>
      )}
    </section>
  );
}

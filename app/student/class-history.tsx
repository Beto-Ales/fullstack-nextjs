import type { listStudentClassHistory } from "@/src/application/academic/academic-service";
import { formatInCenterTimeZone } from "@/src/domain/time/timezone";

type ClassHistoryEntry = Awaited<ReturnType<typeof listStudentClassHistory>>["history"][number];

function cancellationOutcome(entry: ClassHistoryEntry) {
  if (entry.cancellationSource === "ADMIN_DECISION") return "Cancelación por decisión administrativa";
  if (entry.cancellationType === "ON_TIME") return "Cancelación anticipada";
  if (entry.cancellationType === "LATE") return "Cancelación tardía";
  if (entry.sessionStatus === "CANCELLED") return "Clase cancelada";
  if (entry.status === "CANCELLED") return "Reserva cancelada";
}

function formatOutcome(entry: ClassHistoryEntry) {
  const attendance = entry.attendanceOutcome === "ATTENDED" ? "Asistencia registrada"
    : entry.attendanceOutcome === "ABSENT" ? "Falta registrada" : undefined;
  const source = entry.cancellationSource === "STUDENT_REQUEST" ? "Solicitada por el alumno" : undefined;
  return [cancellationOutcome(entry), source, attendance].filter(Boolean).join(" · ") || "Sin asistencia registrada";
}

export function ClassHistory({ entries }: { entries: ClassHistoryEntry[] }) {
  return (
    <section aria-labelledby="class-history-heading" className="my-4 space-y-3">
      <h2 id="class-history-heading">Historial de clases</h2>
      {entries.length === 0 ? <p>Aún no tienes clases en el historial.</p> : (
        <>
          <p>Hora de Copenhague</p>
          <ul className="grid gap-2">
            {entries.map((entry) => (
              <li key={entry.reservationId} className="min-w-0 rounded border p-3 wrap-break-word">
                <p className="font-semibold">{entry.className ?? "Clase única"}</p>
                <p>
                  <time dateTime={entry.startsAtUtc.toISOString()}>
                    {formatInCenterTimeZone(entry.startsAtUtc, "es-ES", {
                      day: "2-digit", month: "2-digit", year: "numeric",
                      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
                    })}
                  </time>
                  {" · "}
                  {entry.origin === "MAKEUP" ? "Recuperación" : entry.habitual ? "Clase habitual" : "Clase ordinaria"}
                </p>
                <p>{formatOutcome(entry)}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

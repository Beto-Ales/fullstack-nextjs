import type { ReactNode } from "react";

import type { getAdminCalendarSessionDetails } from "@/src/application/academic/admin-calendar-service";

type Capacity = NonNullable<Awaited<ReturnType<typeof getAdminCalendarSessionDetails>>>["capacityOverview"];

function availabilityMessage({ bookingStatus, blockedSpots, reservableSpots, confirmedReservations, capacity }: Capacity) {
  switch (bookingStatus) {
    case "CANCELLED": return "Sesión cancelada. Solo se muestra la ocupación registrada.";
    case "COMPLETED": return "Sesión finalizada. Solo se muestra la ocupación registrada.";
    case "IN_PROGRESS": return "Sesión en curso. La reserva de plazas está cerrada.";
    case "UPCOMING":
      if (reservableSpots > 0) return blockedSpots > 0
        ? "Hay plazas reservables y plazas bloqueadas por administración."
        : "Hay plazas reservables.";
      if (confirmedReservations >= capacity) return "Sesión completa. No hay plazas reservables.";
      return "No hay plazas reservables con los bloqueos activos.";
  }
}

export function SessionCapacity({ capacity, children }: { capacity: Capacity; children: ReactNode }) {
  const { physicalCapacity, confirmedReservations, blockedSpots, physicallyFreeSpots,
    reservableSpots, habitualPending, capacityConflict, capacityExcess, confirmedWithCancellation } = capacity;

  return (
    <section aria-labelledby="session-capacity" className="space-y-3 rounded border p-3">
      <h2 id="session-capacity">Aforo y disponibilidad</h2>
      <p className="font-medium">{availabilityMessage(capacity)}</p>
      {physicalCapacity > 0 && (
        <meter aria-label="Aforo físico ocupado y bloqueado" min={0} max={physicalCapacity}
          value={Math.min(confirmedReservations + blockedSpots, physicalCapacity)} className="block h-3 w-full" />
      )}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
        <dt>Capacidad física</dt><dd>{physicalCapacity}</dd>
        <dt>Aforo efectivo</dt><dd>{capacity.capacity}</dd>
        <dt>Plazas ocupadas</dt><dd>{confirmedReservations}</dd>
        <dt>Plazas bloqueadas activas</dt><dd>{blockedSpots}</dd>
        <dt>Plazas físicamente libres</dt><dd>{physicallyFreeSpots}</dd>
        <dt className="font-semibold">Plazas reservables</dt><dd className="font-semibold">{reservableSpots}</dd>
        {habitualPending !== null && (
          <><dt>Habituales pendientes de reserva</dt><dd>{habitualPending}</dd></>
        )}
      </dl>
      {capacityExcess > 0 && (
        <p className="font-semibold">Incidencia de aforo. Las reservas confirmadas y los bloqueos activos superan el aforo efectivo en {capacityExcess} {capacityExcess === 1 ? "plaza" : "plazas"}.</p>
      )}
      {capacityConflict && <p className="font-semibold">Incidencia de aforo. Los habituales pendientes superan las plazas libres.</p>}
      {confirmedWithCancellation > 0 && (
        <p className="font-semibold">Hay reservas con una cancelación registrada que siguen confirmadas en el sistema. Se incluyen en el aforo.</p>
      )}
      {children}
    </section>
  );
}

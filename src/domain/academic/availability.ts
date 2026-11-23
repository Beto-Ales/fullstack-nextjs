export type CapacityBreakdown = {
  capacity: number;
  confirmedReservations: number;
  blockedSpots: number;
};

type BookingStatus = "CANCELLED" | "COMPLETED" | "IN_PROGRESS" | "UPCOMING";

export type { BookingStatus };

export function calculateAvailableSpots(input: CapacityBreakdown) {
  return Math.max(input.capacity - input.confirmedReservations - input.blockedSpots, 0);
}

/**
 * Physical free spots only describe capacity; a session is bookable while it is still upcoming.
 * Admission and revalidation remain authoritative, so this predicate never grants a seat by itself.
 */
export function calculateReservableSpots(input: CapacityBreakdown & { bookingStatus: BookingStatus }) {
  if (input.bookingStatus !== "UPCOMING") return 0;
  return calculateAvailableSpots(input);
}

export function getSessionBookingStatus(session: {
  sessionStatus: "CANCELLED" | "COMPLETED" | "SCHEDULED";
  startsAtUtc: Date;
  endsAtUtc: Date;
}, now: Date): BookingStatus {
  if (session.sessionStatus === "CANCELLED") return "CANCELLED";
  if (session.sessionStatus === "COMPLETED" || session.endsAtUtc <= now) return "COMPLETED";
  if (session.startsAtUtc <= now) return "IN_PROGRESS";
  return "UPCOMING";
}


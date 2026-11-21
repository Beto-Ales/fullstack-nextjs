export type CapacityBreakdown = {
  capacity: number;
  confirmedReservations: number;
  blockedSpots: number;
};

export function calculateAvailableSpots(input: CapacityBreakdown) {
  return Math.max(input.capacity - input.confirmedReservations - input.blockedSpots, 0);
}

type BookingStatus = "CANCELLED" | "COMPLETED" | "IN_PROGRESS" | "UPCOMING";

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


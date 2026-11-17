export type CapacityBreakdown = {
  capacity: number;
  confirmedReservations: number;
  blockedSpots: number;
};

export function calculateAvailableSpots(input: CapacityBreakdown) {
  return Math.max(input.capacity - input.confirmedReservations - input.blockedSpots, 0);
}


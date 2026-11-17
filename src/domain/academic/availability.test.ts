import { describe, expect, it } from "vitest";

import { calculateAvailableSpots } from "@/src/domain/academic/availability";

describe("calculateAvailableSpots", () => {
  it("subtracts confirmed reservations and blocked spots", () => {
    expect(
      calculateAvailableSpots({
        capacity: 12,
        confirmedReservations: 7,
        blockedSpots: 2,
      }),
    ).toBe(3);
  });

  it("never returns negative availability", () => {
    expect(
      calculateAvailableSpots({
        capacity: 12,
        confirmedReservations: 12,
        blockedSpots: 3,
      }),
    ).toBe(0);
  });
});


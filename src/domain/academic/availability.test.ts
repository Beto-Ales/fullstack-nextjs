import { describe, expect, it } from "vitest";

import { calculateAvailableSpots, calculateReservableSpots } from "@/src/domain/academic/availability";

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

describe("calculateReservableSpots", () => {
  it("matches physical availability while the session is upcoming", () => {
    expect(
      calculateReservableSpots({
        bookingStatus: "UPCOMING",
        capacity: 12,
        confirmedReservations: 7,
        blockedSpots: 2,
      }),
    ).toBe(3);
  });

  it("is zero once the session is no longer bookable", () => {
    for (const bookingStatus of ["IN_PROGRESS", "COMPLETED", "CANCELLED"] as const) {
      expect(
        calculateReservableSpots({
          bookingStatus,
          capacity: 12,
          confirmedReservations: 1,
          blockedSpots: 0,
        }),
      ).toBe(0);
    }
  });

  it("is bounded by the regulation capacity, not by the physical capacity", () => {
    expect(
      calculateReservableSpots({
        bookingStatus: "UPCOMING",
        capacity: 2,
        confirmedReservations: 1,
        blockedSpots: 0,
      }),
    ).toBe(1);
    expect(calculateAvailableSpots({ capacity: 4, confirmedReservations: 1, blockedSpots: 0 })).toBe(3);
  });
});


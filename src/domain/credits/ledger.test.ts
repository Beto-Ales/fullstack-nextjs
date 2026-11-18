import { describe, expect, it } from "vitest";

import { calculateAutoCreditExpiration, calculateAvailableCredits, getCenterMonthUtcWindow } from "@/src/domain/credits/ledger";

describe("credit ledger helpers", () => {
  it("calculates month window in Europe/Copenhagen", () => {
    const reference = new Date("2026-03-31T22:30:00.000Z");
    const window = getCenterMonthUtcWindow(reference);

    expect(window.monthStartUtc.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    expect(window.nextMonthStartUtc.toISOString()).toBe("2026-04-30T22:00:00.000Z");
  });

  it("calculates auto credit expiration at +6 months", () => {
    const generated = new Date("2026-01-10T09:15:00.000Z");
    const expiresAt = calculateAutoCreditExpiration(generated);

    expect(expiresAt.toISOString()).toBe("2026-07-10T08:15:00.000Z");
  });

  it("calculates available credits excluding debits", () => {
    const available = calculateAvailableCredits([
      { movementType: "AUTO_CANCELLATION_GRANT", amount: 1 },
      { movementType: "MANUAL_GRANT", amount: 2 },
      { movementType: "MANUAL_WITHDRAWAL", amount: 1 },
      { movementType: "EXPIRATION", amount: 1 },
    ]);

    expect(available).toBe(1);
  });

  it("never returns negative available credits", () => {
    const available = calculateAvailableCredits([
      { movementType: "MANUAL_GRANT", amount: 1 },
      { movementType: "MANUAL_WITHDRAWAL", amount: 3 },
    ]);

    expect(available).toBe(0);
  });

  it("ignores refunds that were logged after credit expiration", () => {
    const available = calculateAvailableCredits([
      { movementType: "MANUAL_GRANT", amount: 1 },
      { movementType: "RECOVERY_CONSUMPTION", amount: 1 },
      { movementType: "RECOVERY_REFUND", amount: 1, refundRestoredCredit: false },
    ]);

    expect(available).toBe(0);
  });
});


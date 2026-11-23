import { describe, expect, it } from "vitest";

import type { CreditMovementType } from "@/src/domain/credits/ledger";
import {
  formatCalendarDate, formatCreditMovement, formatCreditQuantity,
  formatHistoryInstant, formatPendingCreditRequests,
} from "./history-format";

describe("history formatting", () => {
  it("keeps calendar dates unchanged across DST and calendar boundaries", () => {
    expect(formatCalendarDate("2026-03-29")).toBe("29/03/2026");
    expect(formatCalendarDate("2026-10-25")).toBe("25/10/2026");
    expect(formatCalendarDate("2026-12-31")).toBe("31/12/2026");
    expect(formatCalendarDate("2028-02-29")).toBe("29/02/2028");
  });

  it.each([
    ["2026-02-28T23:00:00Z", "01/03/2026, 00:00 GMT+01:00"],
    ["2026-05-31T21:59:00Z", "31/05/2026, 23:59 GMT+02:00"],
    ["2026-05-31T22:00:00Z", "01/06/2026, 00:00 GMT+02:00"],
    ["2026-12-31T23:00:00Z", "01/01/2027, 00:00 GMT+01:00"],
    ["2026-03-29T00:59:00Z", "29/03/2026, 01:59 GMT+01:00"],
    ["2026-03-29T01:00:00Z", "29/03/2026, 03:00 GMT+02:00"],
    ["2026-10-25T00:30:00Z", "25/10/2026, 02:30 GMT+02:00"],
    ["2026-10-25T01:30:00Z", "25/10/2026, 02:30 GMT+01:00"],
  ])("formats %s in Copenhagen", (utc, expected) => {
    expect(formatHistoryInstant(new Date(utc))).toBe(expected);
  });

  it("renders the local calendar day of an instant when only a date is needed", () => {
    expect(formatHistoryInstant(new Date("2026-12-31T23:00:00Z"), true)).toBe("01/01/2027");
  });

  it("handles missing and invalid values without coercion or rounding", () => {
    expect(formatCalendarDate(null)).toBeNull();
    expect(formatCalendarDate("2026-02-29")).toBeNull();
    expect(formatCalendarDate("2026-03-29T00:00:00Z")).toBeNull();
    expect(formatHistoryInstant(null)).toBeNull();
    expect(formatHistoryInstant(new Date(NaN))).toBeNull();
    expect(formatCreditQuantity(null)).toBe("Cantidad de créditos sin registrar");
    expect(formatCreditQuantity(NaN)).toBe("Cantidad de créditos sin registrar");
    expect(formatCreditQuantity(1.5)).toBe("Cantidad de créditos sin registrar");
  });

  it("formats credit quantities and pending requests independently", () => {
    expect(formatCreditQuantity(0)).toBe("0 créditos");
    expect(formatCreditQuantity(1)).toBe("1 crédito");
    expect(formatCreditQuantity(12345)).toBe("12.345 créditos");
    expect(formatPendingCreditRequests(1)).toBe("1 solicitud de crédito pendiente");
    expect(formatPendingCreditRequests(3)).toBe("3 solicitudes de crédito pendientes");
  });

  const movements: [CreditMovementType, string][] = [
    ["AUTO_CANCELLATION_GRANT", "Concesión por cancelación · +1 crédito"],
    ["MANUAL_GRANT", "Concesión manual · +1 crédito"],
    ["MANUAL_WITHDRAWAL", "Retirada manual · −1 crédito"],
    ["EXPIRATION", "Caducidad · −1 crédito"],
    ["RECOVERY_CONSUMPTION", "Consumo por recuperación · −1 crédito"],
    ["RECOVERY_REFUND", "Devolución de recuperación · +1 crédito"],
  ];

  it.each(movements)("labels the quantity and direction of %s", (movementType, expected) => {
    expect(formatCreditMovement({ movementType, amount: 1, refundRestoredCredit: true })).toBe(expected);
  });

  it("distinguishes a refund record from a confirmed credit to the balance", () => {
    const movement = { movementType: "RECOVERY_REFUND", amount: 1 } as const;
    expect(formatCreditMovement({ ...movement, refundRestoredCredit: false }))
      .toBe("Devolución de recuperación sin abono al saldo · 1 crédito");
    expect(formatCreditMovement({ ...movement, refundRestoredCredit: null }))
      .toBe("Devolución de recuperación con abono al saldo sin registrar · 1 crédito");
  });
});

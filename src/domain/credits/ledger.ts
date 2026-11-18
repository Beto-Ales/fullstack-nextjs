import { DateTime } from "luxon";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";

export type CreditMovementType =
  | "AUTO_CANCELLATION_GRANT"
  | "MANUAL_GRANT"
  | "MANUAL_WITHDRAWAL"
  | "EXPIRATION"
  | "RECOVERY_CONSUMPTION"
  | "RECOVERY_REFUND";

export type CreditMovementSnapshot = {
  movementType: CreditMovementType;
  amount: number;
  refundRestoredCredit?: boolean | null;
};

const CREDIT_MOVEMENT_TYPES: CreditMovementType[] = ["AUTO_CANCELLATION_GRANT", "MANUAL_GRANT", "RECOVERY_REFUND"];
const DEBIT_MOVEMENT_TYPES: CreditMovementType[] = ["MANUAL_WITHDRAWAL", "EXPIRATION", "RECOVERY_CONSUMPTION"];

export function calculateAutoCreditExpiration(generatedAtUtc: Date): Date {
  return DateTime.fromJSDate(generatedAtUtc, { zone: "utc" }).setZone(CENTER_TIME_ZONE).plus({ months: 6 }).toUTC().toJSDate();
}

export function getCenterMonthUtcWindow(referenceDateUtc: Date): { monthStartUtc: Date; nextMonthStartUtc: Date } {
  const localReference = DateTime.fromJSDate(referenceDateUtc, { zone: "utc" }).setZone(CENTER_TIME_ZONE);
  const monthStartLocal = localReference.startOf("month");

  return {
    monthStartUtc: monthStartLocal.toUTC().toJSDate(),
    nextMonthStartUtc: monthStartLocal.plus({ months: 1 }).toUTC().toJSDate(),
  };
}

export function calculateAvailableCredits(movements: CreditMovementSnapshot[]): number {
  let credits = 0;
  let debits = 0;

  for (const movement of movements) {
    if (movement.movementType === "RECOVERY_REFUND" && !movement.refundRestoredCredit) {
      continue;
    }
    if (CREDIT_MOVEMENT_TYPES.includes(movement.movementType)) {
      credits += movement.amount;
      continue;
    }
    if (DEBIT_MOVEMENT_TYPES.includes(movement.movementType)) {
      debits += movement.amount;
    }
  }

  return Math.max(0, credits - debits);
}


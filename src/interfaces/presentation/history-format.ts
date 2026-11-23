import { DateTime } from "luxon";

import type { CreditMovementSnapshot } from "@/src/domain/credits/ledger";
import { formatInCenterTimeZone } from "@/src/domain/time/timezone";

const dateFields = { day: "2-digit", month: "2-digit", year: "numeric" } as const;
const integers = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });

export function formatCalendarDate(value?: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = DateTime.fromISO(value, { zone: "UTC", locale: "es-ES" });
  return date.isValid ? date.toFormat("dd/MM/yyyy") : null;
}

export function formatHistoryInstant(value?: Date | null, dateOnly = false): string | null {
  if (!value || !Number.isFinite(value.getTime())) return null;
  return formatInCenterTimeZone(value, "es-ES", dateOnly ? dateFields : {
    ...dateFields, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  });
}

export function formatHistoryInteger(amount?: number | null): string {
  return amount != null && Number.isSafeInteger(amount) ? integers.format(amount) : "Sin dato";
}

export function formatCreditQuantity(amount?: number | null): string {
  if (amount == null || !Number.isSafeInteger(amount)) return "Cantidad de créditos sin registrar";
  return `${formatHistoryInteger(amount)} ${Math.abs(amount) === 1 ? "crédito" : "créditos"}`;
}

export function formatPendingCreditRequests(amount: number): string {
  return `${formatHistoryInteger(amount)} ${amount === 1 ? "solicitud de crédito pendiente" : "solicitudes de crédito pendientes"}`;
}

const movements = {
  AUTO_CANCELLATION_GRANT: { label: "Concesión por cancelación", sign: "+" },
  MANUAL_GRANT: { label: "Concesión manual", sign: "+" },
  MANUAL_WITHDRAWAL: { label: "Retirada manual", sign: "−" },
  EXPIRATION: { label: "Caducidad", sign: "−" },
  RECOVERY_CONSUMPTION: { label: "Consumo por recuperación", sign: "−" },
  RECOVERY_REFUND: { label: "Devolución de recuperación", sign: "+" },
} satisfies Record<CreditMovementSnapshot["movementType"], { label: string; sign: string }>;

export function formatCreditMovement({ movementType, amount, refundRestoredCredit }: CreditMovementSnapshot): string {
  const { label, sign } = movements[movementType];
  const quantity = formatCreditQuantity(amount);
  if (movementType === "RECOVERY_REFUND" && refundRestoredCredit !== true) {
    const effect = refundRestoredCredit === false ? "sin abono al saldo" : "con abono al saldo sin registrar";
    return `${label} ${effect} · ${quantity}`;
  }
  return `${label} · ${Number.isSafeInteger(amount) && amount > 0 ? sign : ""}${quantity}`;
}

export const recoveryReservationLabels = {
  CONFIRMED: "Confirmada",
  CANCELLED: "Cancelada",
} as const;

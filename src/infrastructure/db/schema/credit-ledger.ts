import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { classReservations } from "@/src/infrastructure/db/schema/class-reservations";
import { classSessions } from "@/src/infrastructure/db/schema/class-sessions";
import { reservationCancellations } from "@/src/infrastructure/db/schema/reservation-cancellations";
import { studentProfiles } from "@/src/infrastructure/db/schema/student-profiles";
import { users } from "@/src/infrastructure/db/schema/users";

import { academicRegulations } from "@/src/infrastructure/db/schema/academic-regulations";

export const creditMovementTypeEnum = pgEnum("credit_movement_type", [
  "AUTO_CANCELLATION_GRANT",
  "MANUAL_GRANT",
  "MANUAL_WITHDRAWAL",
  "EXPIRATION",
  "RECOVERY_CONSUMPTION",
  "RECOVERY_REFUND",
]);

export const creditLedgerMovements = pgTable(
  "credit_ledger_movements",
  {
    id: text("id").primaryKey(),
    studentProfileId: text("student_profile_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    movementType: creditMovementTypeEnum("movement_type").notNull(),
    amount: integer("amount").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    reason: text("reason"),
    classSessionId: text("class_session_id").references(() => classSessions.id, { onDelete: "set null" }),
    relatedReservationId: text("related_reservation_id").references(() => classReservations.id, { onDelete: "set null" }),
    adminUserId: text("admin_user_id").references(() => users.id, { onDelete: "set null" }),
    sourceCancellationId: text("source_cancellation_id").references(() => reservationCancellations.id, {
      onDelete: "set null",
    }),
    sourceGrantMovementId: text("source_grant_movement_id"),
    sourceMovementId: text("source_movement_id"),
    refundRestoredCredit: boolean("refund_restored_credit"),
    idempotencyKey: text("idempotency_key").notNull(),
    regulationVersionId: text("regulation_version_id").references(() => academicRegulations.id),
  },
  (table) => [
    index("credit_ledger_student_created_idx").on(table.studentProfileId, table.createdAt),
    index("credit_ledger_expires_idx").on(table.expiresAt),
    uniqueIndex("credit_ledger_idempotency_key_unique_idx").on(table.idempotencyKey),
    uniqueIndex("credit_ledger_auto_cancellation_unique_idx")
      .on(table.sourceCancellationId)
      .where(sql`${table.movementType} = 'AUTO_CANCELLATION_GRANT' and ${table.sourceCancellationId} is not null`),
    uniqueIndex("credit_ledger_expiration_source_unique_idx")
      .on(table.sourceMovementId)
      .where(sql`${table.movementType} = 'EXPIRATION' and ${table.sourceMovementId} is not null`),
    uniqueIndex("credit_ledger_recovery_consumption_per_reservation_unique_idx")
      .on(table.relatedReservationId)
      .where(sql`${table.movementType} = 'RECOVERY_CONSUMPTION' and ${table.relatedReservationId} is not null`),
    uniqueIndex("credit_ledger_recovery_refund_per_consumption_unique_idx")
      .on(table.sourceMovementId)
      .where(sql`${table.movementType} = 'RECOVERY_REFUND' and ${table.sourceMovementId} is not null`),
  ],
);


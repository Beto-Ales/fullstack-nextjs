import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { users } from "@/src/infrastructure/db/schema/users";

export const studentWithdrawals = pgTable("student_withdrawals", {
  studentUserId: text("student_user_id").primaryKey().references(() => users.id),
  withdrawnByUserId: text("withdrawn_by_user_id").notNull().references(() => users.id),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }).notNull(),
  endedAssignmentIds: jsonb("ended_assignment_ids").$type<string[]>().notNull(),
  releasedReservationIds: jsonb("released_reservation_ids").$type<string[]>().notNull(),
  cancelledRecoveries: jsonb("cancelled_recoveries").$type<{
    reservationId: string;
    refunded: boolean;
    refundRestoredCredit: boolean;
  }[]>().notNull(),
});

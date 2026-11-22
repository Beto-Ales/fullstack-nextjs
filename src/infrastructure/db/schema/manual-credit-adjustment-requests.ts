import { pgTable, text, uuid } from "drizzle-orm/pg-core";

export const manualCreditAdjustmentRequests = pgTable("manual_credit_adjustment_requests", {
  id: uuid("id").primaryKey(),
  adminUserId: text("admin_user_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
});

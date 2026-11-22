import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const loginAttemptBudgets = pgTable("login_attempt_budgets", {
  key: varchar("key", { length: 64 }).primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("login_attempt_budgets_expires_at_idx").on(table.expiresAt),
  check("login_attempt_budgets_attempts_check", sql`${table.attempts} between 1 and 600`),
]);

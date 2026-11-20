import { date, integer, jsonb, pgTable, text, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";

import type { RegulationChanges } from "@/src/domain/academic/regulation";
import { users } from "@/src/infrastructure/db/schema/users";

export const academicRegulations = pgTable("academic_regulations", {
  id: text("id").primaryKey(),
  effectiveFrom: date("effective_from").notNull().unique(),
  cancellationNoticeDays: integer("cancellation_notice_days").notNull(),
  monthlyCancellationCredits: integer("monthly_cancellation_credits").notNull(),
  monthlyRecoveries: integer("monthly_recoveries").notNull(),
  creditExpirationMonths: integer("credit_expiration_months").notNull(),
  maxClassCapacity: integer("max_class_capacity").notNull(),
  previousVersionId: text("previous_version_id").references((): AnyPgColumn => academicRegulations.id),
  publishedByUserId: text("published_by_user_id").references(() => users.id),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  changes: jsonb("changes").$type<RegulationChanges>().notNull(),
});

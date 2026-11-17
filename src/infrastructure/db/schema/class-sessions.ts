import { boolean, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { classTemplates } from "@/src/infrastructure/db/schema/class-templates";

export const classSessionStatusEnum = pgEnum("class_session_status", ["SCHEDULED", "CANCELLED", "COMPLETED"]);

export const classSessions = pgTable(
  "class_sessions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id").references(() => classTemplates.id, { onDelete: "set null" }),
    localDate: date("local_date").notNull(),
    startsAtUtc: timestamp("starts_at_utc", { withTimezone: true }).notNull(),
    endsAtUtc: timestamp("ends_at_utc", { withTimezone: true }).notNull(),
    status: classSessionStatusEnum("status").notNull().default("SCHEDULED"),
    maxCapacity: integer("max_capacity").notNull(),
    isManuallyEdited: boolean("is_manually_edited").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("class_sessions_template_local_date_unique_idx")
      .on(table.templateId, table.localDate)
      .where(sql`${table.templateId} is not null`),
    index("class_sessions_starts_at_idx").on(table.startsAtUtc),
    index("class_sessions_status_idx").on(table.status),
  ],
);

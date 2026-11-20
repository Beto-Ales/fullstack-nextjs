import { date, index, integer, pgEnum, pgTable, text, time, timestamp } from "drizzle-orm/pg-core";

import { DEFAULT_CLASS_CAPACITY } from "@/src/domain/academic/constants";

import { academicRegulations } from "@/src/infrastructure/db/schema/academic-regulations";

export const classTemplateStatusEnum = pgEnum("class_template_status", ["ACTIVE", "INACTIVE"]);

export const classTemplates = pgTable(
  "class_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    isoWeekday: integer("iso_weekday").notNull(),
    startsAtLocalTime: time("starts_at_local_time").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    status: classTemplateStatusEnum("status").notNull().default("ACTIVE"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    category: text("category"),
    regulationVersionId: text("regulation_version_id").references(() => academicRegulations.id),
    maxCapacity: integer("max_capacity").notNull().default(DEFAULT_CLASS_CAPACITY),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("class_templates_weekday_idx").on(table.isoWeekday),
    index("class_templates_status_idx").on(table.status),
  ],
);

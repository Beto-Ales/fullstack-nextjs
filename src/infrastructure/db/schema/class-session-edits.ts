import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { academicRegulations } from "@/src/infrastructure/db/schema/academic-regulations";
import { classSessions, classSessionStatusEnum } from "@/src/infrastructure/db/schema/class-sessions";
import { users } from "@/src/infrastructure/db/schema/users";

export const classSessionEdits = pgTable("class_session_edits", {
  id: text("id").primaryKey(),
  classSessionId: text("class_session_id").notNull().references(() => classSessions.id, { onDelete: "cascade" }),
  regulationVersionId: text("regulation_version_id").notNull().references(() => academicRegulations.id),
  editedByUserId: text("edited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
  startsAtUtc: timestamp("starts_at_utc", { withTimezone: true }).notNull(),
  endsAtUtc: timestamp("ends_at_utc", { withTimezone: true }).notNull(),
  maxCapacity: integer("max_capacity").notNull(),
  status: classSessionStatusEnum("status").notNull(),
}, (table) => [index("class_session_edits_session_idx").on(table.classSessionId, table.editedAt)]);

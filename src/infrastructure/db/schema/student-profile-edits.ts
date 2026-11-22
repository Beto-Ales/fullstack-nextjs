import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { studentProfiles } from "@/src/infrastructure/db/schema/student-profiles";
import { users } from "@/src/infrastructure/db/schema/users";

export const studentProfileEdits = pgTable("student_profile_edits", {
  id: text("id").primaryKey(),
  studentProfileId: text("student_profile_id").notNull().references(() => studentProfiles.id),
  editedByUserId: text("edited_by_user_id").notNull().references(() => users.id),
  editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow().notNull(),
  operation: text("operation").$type<"UPDATE_STUDENT_DETAILS">().notNull(),
  changes: jsonb("changes").$type<Record<string, { before: string | null; after: string | null }>>().notNull(),
}, (table) => [index("student_profile_edits_student_date_idx").on(table.studentProfileId, table.editedAt)]);

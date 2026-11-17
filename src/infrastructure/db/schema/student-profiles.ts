import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "@/src/infrastructure/db/schema/users";

export const studentProfiles = pgTable(
  "student_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    adminNotes: text("admin_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("student_profiles_user_id_unique_idx").on(table.userId),
    index("student_profiles_last_name_idx").on(table.lastName),
  ],
);


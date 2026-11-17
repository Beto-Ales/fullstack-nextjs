import { date, index, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { classTemplates } from "@/src/infrastructure/db/schema/class-templates";
import { studentProfiles } from "@/src/infrastructure/db/schema/student-profiles";

export const studentTemplateAssignmentStatusEnum = pgEnum("student_template_assignment_status", ["ACTIVE", "ENDED"]);

export const studentTemplateAssignments = pgTable(
  "student_template_assignments",
  {
    id: text("id").primaryKey(),
    studentProfileId: text("student_profile_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    templateId: text("template_id")
      .notNull()
      .references(() => classTemplates.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: studentTemplateAssignmentStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("student_template_assignments_active_unique_idx")
      .on(table.studentProfileId, table.templateId)
      .where(sql`${table.status} = 'ACTIVE' and ${table.effectiveTo} is null`),
    index("student_template_assignments_student_idx").on(table.studentProfileId),
    index("student_template_assignments_template_idx").on(table.templateId),
  ],
);


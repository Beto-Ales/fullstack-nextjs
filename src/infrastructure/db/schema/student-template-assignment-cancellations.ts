import { date, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { academicRegulations } from "@/src/infrastructure/db/schema/academic-regulations";
import { classTemplates } from "@/src/infrastructure/db/schema/class-templates";
import { studentProfiles } from "@/src/infrastructure/db/schema/student-profiles";
import { studentTemplateAssignments } from "@/src/infrastructure/db/schema/student-template-assignments";
import { users } from "@/src/infrastructure/db/schema/users";

export const studentTemplateAssignmentCancellationSourceEnum = pgEnum(
  "student_template_assignment_cancellation_source",
  ["ADMIN_INDIVIDUAL", "STUDENT_WITHDRAWAL"],
);

export const studentTemplateAssignmentCancellations = pgTable(
  "student_template_assignment_cancellations",
  {
    id: text("id").primaryKey(),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => studentTemplateAssignments.id, { onDelete: "cascade" }),
    studentProfileId: text("student_profile_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    templateId: text("template_id")
      .notNull()
      .references(() => classTemplates.id, { onDelete: "cascade" }),
    source: studentTemplateAssignmentCancellationSourceEnum("source").notNull(),
    cancelledByUserId: text("cancelled_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    cancelledReservationIds: jsonb("cancelled_reservation_ids").$type<string[]>().notNull(),
    ambiguousReservationIds: jsonb("ambiguous_reservation_ids").$type<string[]>().notNull(),
    regulationVersionId: text("regulation_version_id").references(() => academicRegulations.id),
  },
  (table) => [
    uniqueIndex("student_template_assignment_cancellations_assignment_unique_idx").on(table.assignmentId),
    index("student_template_assignment_cancellations_student_idx").on(table.studentProfileId),
    index("student_template_assignment_cancellations_template_idx").on(table.templateId),
  ],
);

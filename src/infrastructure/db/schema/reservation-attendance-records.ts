import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { classReservations } from "@/src/infrastructure/db/schema/class-reservations";
import { classSessions } from "@/src/infrastructure/db/schema/class-sessions";
import { studentProfiles } from "@/src/infrastructure/db/schema/student-profiles";
import { users } from "@/src/infrastructure/db/schema/users";

import { academicRegulations } from "@/src/infrastructure/db/schema/academic-regulations";

export const attendanceOutcomeEnum = pgEnum("attendance_outcome", ["ATTENDED", "ABSENT"]);
export const attendanceSourceEnum = pgEnum("attendance_source", ["MANUAL", "AUTO"]);

export const reservationAttendanceRecords = pgTable(
  "reservation_attendance_records",
  {
    id: text("id").primaryKey(),
    regulationVersionId: text("regulation_version_id").references(() => academicRegulations.id),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => classReservations.id, { onDelete: "cascade" }),
    studentProfileId: text("student_profile_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    classSessionId: text("class_session_id")
      .notNull()
      .references(() => classSessions.id, { onDelete: "cascade" }),
    outcome: attendanceOutcomeEnum("outcome").notNull(),
    source: attendanceSourceEnum("source").notNull(),
    recordedByUserId: text("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    correctionReason: text("correction_reason"),
    correctedFromRecordId: text("corrected_from_record_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("reservation_attendance_active_unique_idx")
      .on(table.reservationId)
      .where(sql`${table.supersededAt} is null`),
    index("reservation_attendance_profile_idx").on(table.studentProfileId),
    index("reservation_attendance_session_idx").on(table.classSessionId),
    index("reservation_attendance_recorded_at_idx").on(table.recordedAt),
  ],
);


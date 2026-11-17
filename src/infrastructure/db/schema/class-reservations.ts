import { index, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { classSessions } from "@/src/infrastructure/db/schema/class-sessions";
import { studentProfiles } from "@/src/infrastructure/db/schema/student-profiles";

export const classReservationStatusEnum = pgEnum("class_reservation_status", ["CONFIRMED", "CANCELLED"]);
export const classReservationOriginEnum = pgEnum("class_reservation_origin", ["ORDINARY", "MAKEUP"]);

export const classReservations = pgTable(
  "class_reservations",
  {
    id: text("id").primaryKey(),
    classSessionId: text("class_session_id")
      .notNull()
      .references(() => classSessions.id, { onDelete: "cascade" }),
    studentProfileId: text("student_profile_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    status: classReservationStatusEnum("status").notNull().default("CONFIRMED"),
    origin: classReservationOriginEnum("origin").notNull().default("ORDINARY"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("class_reservations_active_unique_idx")
      .on(table.classSessionId, table.studentProfileId)
      .where(sql`${table.status} = 'CONFIRMED'`),
    index("class_reservations_session_idx").on(table.classSessionId),
    index("class_reservations_profile_idx").on(table.studentProfileId),
  ],
);


import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { classReservations } from "@/src/infrastructure/db/schema/class-reservations";
import { classSessions } from "@/src/infrastructure/db/schema/class-sessions";
import { studentProfiles } from "@/src/infrastructure/db/schema/student-profiles";
import { users } from "@/src/infrastructure/db/schema/users";

import { academicRegulations } from "@/src/infrastructure/db/schema/academic-regulations";

export const reservationCancellationTypeEnum = pgEnum("reservation_cancellation_type", ["ON_TIME", "LATE"]);
export const cancellationNonEligibilityReasonEnum = pgEnum("cancellation_non_eligibility_reason", [
  "TIMING",
  "SEQUENCE_POSITION",
  "NON_HABITUAL",
]);

export const reservationCancellations = pgTable(
  "reservation_cancellations",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => classReservations.id, { onDelete: "cascade" }),
    studentProfileId: text("student_profile_id")
      .notNull()
      .references(() => studentProfiles.id, { onDelete: "cascade" }),
    classSessionId: text("class_session_id")
      .notNull()
      .references(() => classSessions.id, { onDelete: "cascade" }),
    cancelledByUserId: text("cancelled_by_user_id").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }).notNull(),
    regulationVersionId: text("regulation_version_id").references(() => academicRegulations.id),
    cancellationType: reservationCancellationTypeEnum("cancellation_type").notNull(),
    hoursBeforeStart: integer("hours_before_start").notNull(),
    meetsSevenDayRule: boolean("meets_seven_day_rule").notNull(),
    isHabitualReservation: boolean("is_habitual_reservation").notNull(),
    sequenceId: text("sequence_id"),
    sequencePosition: integer("sequence_position"),
    isThirdCancellation: boolean("is_third_cancellation").notNull().default(false),
    canGenerateCreditCandidate: boolean("can_generate_credit_candidate").notNull().default(false),
    nonEligibilityReason: cancellationNonEligibilityReasonEnum("non_eligibility_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("reservation_cancellations_reservation_unique_idx").on(table.reservationId),
    index("reservation_cancellations_profile_idx").on(table.studentProfileId),
    index("reservation_cancellations_session_idx").on(table.classSessionId),
    index("reservation_cancellations_cancelled_at_idx").on(table.cancelledAt),
    index("reservation_cancellations_sequence_idx").on(table.sequenceId),
  ],
);


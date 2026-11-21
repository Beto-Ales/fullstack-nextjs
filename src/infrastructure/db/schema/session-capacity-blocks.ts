import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { classSessions } from "@/src/infrastructure/db/schema/class-sessions";
import { users } from "@/src/infrastructure/db/schema/users";

import { academicRegulations } from "@/src/infrastructure/db/schema/academic-regulations";

export const sessionCapacityBlocks = pgTable(
  "session_capacity_blocks",
  {
    id: text("id").primaryKey(),
    regulationVersionId: text("regulation_version_id").references(() => academicRegulations.id),
    classSessionId: text("class_session_id")
      .notNull()
      .references(() => classSessions.id, { onDelete: "cascade" }),
    blockedSpots: integer("blocked_spots").notNull(),
    reason: text("reason"),
    blockedByUserId: text("blocked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    releasedByUserId: text("released_by_user_id").references(() => users.id, { onDelete: "set null" }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("session_capacity_blocks_session_idx").on(table.classSessionId),
    index("session_capacity_blocks_active_idx").on(table.isActive),
  ],
);


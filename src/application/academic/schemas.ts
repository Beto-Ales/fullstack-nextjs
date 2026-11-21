import { z } from "zod";

import { DEFAULT_CLASS_CAPACITY } from "@/src/domain/academic/constants";
import { ISO_WEEK_DAYS } from "@/src/domain/academic/types";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD format.");
const localTimeSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Time must use HH:mm or HH:mm:ss format.");
const calendarTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);

export const createStudentProfileSchema = z.object({
  userId: z.string().uuid("Invalid user id."),
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  contactPhone: z.string().max(60).optional(),
  contactEmail: z.string().email().max(255).optional(),
  adminNotes: z.string().max(2_000).optional(),
});

export const createClassTemplateSchema = z.object({
  name: z.string().min(1).max(150),
  isoWeekday: z.number().int().refine((value) => ISO_WEEK_DAYS.includes(value as (typeof ISO_WEEK_DAYS)[number])),
  startsAtLocalTime: localTimeSchema,
  durationMinutes: z.number().int().min(15).max(360),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.optional(),
  category: z.string().max(120).optional(),
  maxCapacity: z.number().int().min(1).max(DEFAULT_CLASS_CAPACITY).optional(),
});

export const setClassTemplateStatusSchema = z.object({
  templateId: z.string().uuid("Invalid template id."),
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

export const createOneOffSessionSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  localDate: z.iso.date(),
  startsAtLocalTime: calendarTimeSchema,
  durationMinutes: z.number().int().min(15).max(360),
  maxCapacity: z.number().int().min(1).max(DEFAULT_CLASS_CAPACITY).optional(),
});

export const createWeeklyCourseSchema = createClassTemplateSchema.pick({
  name: true,
  durationMinutes: true,
  maxCapacity: true,
}).extend({
  firstClassDate: z.iso.date(),
  startsAtLocalTime: calendarTimeSchema,
});

export const updateClassSessionSchema = z.object({
  classSessionId: z.string().uuid("Invalid session id."),
  startsAtUtc: z.coerce.date().optional(),
  endsAtUtc: z.coerce.date().optional(),
  maxCapacity: z.number().int().min(1).max(DEFAULT_CLASS_CAPACITY).optional(),
  status: z.enum(["SCHEDULED", "CANCELLED", "COMPLETED"]).optional(),
});

export const cancelClassSessionSchema = z.object({
  classSessionId: z.string().uuid("Invalid session id."),
});

export const assignStudentTemplateSchema = z.object({
  studentProfileId: z.string().uuid("Invalid student profile id."),
  templateId: z.string().uuid("Invalid template id."),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.optional(),
});

export const endStudentTemplateAssignmentSchema = z.object({
  assignmentId: z.string().uuid("Invalid assignment id."),
  effectiveTo: isoDateSchema.optional(),
});

export const reserveSeatSchema = z.object({
  classSessionId: z.string().uuid("Invalid class session id."),
  studentProfileId: z.string().uuid("Invalid student profile id."),
  origin: z.enum(["ORDINARY", "MAKEUP"]).default("ORDINARY"),
});

export const ordinaryEnrollmentSchema = z.object({
  studentProfileId: z.string().uuid(),
  targetType: z.enum(["weekly", "one-off"]),
  targetId: z.string().uuid(),
});

export const cancelReservationSchema = z.object({
  reservationId: z.string().uuid("Invalid reservation id."),
});

export const recordAttendanceSchema = z.object({
  classSessionId: z.string().uuid("Invalid class session id."),
  reservationId: z.string().uuid("Invalid reservation id."),
  outcome: z.enum(["PRESENT", "ATTENDED", "ABSENT"])
    .transform((outcome) => outcome === "PRESENT" ? "ATTENDED" : outcome),
});

export const correctAttendanceSchema = recordAttendanceSchema.extend({
  reason: z.string().trim().min(3).max(300),
});

export const blockCapacitySchema = z.object({
  classSessionId: z.string().uuid("Invalid class session id."),
  blockedSpots: z.number().int().min(1).max(100),
  reason: z.string().max(300).optional(),
  isActive: z.boolean().default(true),
});

export const generateSessionsSchema = z.object({
  horizonMonths: z.number().int().min(1).max(12).default(3),
});

export const detectAbsencesSchema = z.object({
  referenceTimeUtc: z.coerce.date().optional(),
});

export const cancellationHistorySchema = z.object({
  studentProfileId: z.string().uuid("Invalid student profile id.").optional(),
});

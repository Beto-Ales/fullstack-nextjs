CREATE TYPE "public"."reservation_cancellation_source" AS ENUM('STUDENT_REQUEST', 'ADMIN_DECISION');--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD COLUMN "decision_source" "reservation_cancellation_source";--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD COLUMN "administrative_reason" text;
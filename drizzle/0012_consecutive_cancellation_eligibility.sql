CREATE TYPE "public"."cancellation_credit_resolution" AS ENUM('GRANTED', 'MONTHLY_LIMIT', 'NOT_ELIGIBLE');--> statement-breakpoint
ALTER TABLE "academic_regulations" ADD COLUMN "max_eligible_consecutive_cancellations" integer;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD COLUMN "sequence_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD COLUMN "credit_resolution" "cancellation_credit_resolution";--> statement-breakpoint
CREATE INDEX "reservation_cancellations_pending_profile_idx" ON "reservation_cancellations" USING btree ("student_profile_id") WHERE "reservation_cancellations"."sequence_pending";
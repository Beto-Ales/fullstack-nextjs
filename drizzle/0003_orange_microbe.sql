CREATE TYPE "public"."attendance_outcome" AS ENUM('ATTENDED', 'ABSENT');--> statement-breakpoint
CREATE TYPE "public"."attendance_source" AS ENUM('MANUAL', 'AUTO');--> statement-breakpoint
CREATE TYPE "public"."cancellation_non_eligibility_reason" AS ENUM('TIMING', 'SEQUENCE_POSITION', 'NON_HABITUAL');--> statement-breakpoint
CREATE TYPE "public"."reservation_cancellation_type" AS ENUM('ON_TIME', 'LATE');--> statement-breakpoint
CREATE TABLE "reservation_attendance_records" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"student_profile_id" text NOT NULL,
	"class_session_id" text NOT NULL,
	"outcome" "attendance_outcome" NOT NULL,
	"source" "attendance_source" NOT NULL,
	"recorded_by_user_id" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"correction_reason" text,
	"corrected_from_record_id" text,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation_cancellations" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"student_profile_id" text NOT NULL,
	"class_session_id" text NOT NULL,
	"cancelled_by_user_id" text,
	"cancelled_at" timestamp with time zone NOT NULL,
	"cancellation_type" "reservation_cancellation_type" NOT NULL,
	"hours_before_start" integer NOT NULL,
	"meets_seven_day_rule" boolean NOT NULL,
	"is_habitual_reservation" boolean NOT NULL,
	"sequence_id" text,
	"sequence_position" integer,
	"is_third_cancellation" boolean DEFAULT false NOT NULL,
	"can_generate_credit_candidate" boolean DEFAULT false NOT NULL,
	"non_eligibility_reason" "cancellation_non_eligibility_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reservation_attendance_records" ADD CONSTRAINT "reservation_attendance_records_reservation_id_class_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."class_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_attendance_records" ADD CONSTRAINT "reservation_attendance_records_student_profile_id_student_profiles_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_attendance_records" ADD CONSTRAINT "reservation_attendance_records_class_session_id_class_sessions_id_fk" FOREIGN KEY ("class_session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_attendance_records" ADD CONSTRAINT "reservation_attendance_records_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD CONSTRAINT "reservation_cancellations_reservation_id_class_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."class_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD CONSTRAINT "reservation_cancellations_student_profile_id_student_profiles_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD CONSTRAINT "reservation_cancellations_class_session_id_class_sessions_id_fk" FOREIGN KEY ("class_session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD CONSTRAINT "reservation_cancellations_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_attendance_active_unique_idx" ON "reservation_attendance_records" USING btree ("reservation_id") WHERE "reservation_attendance_records"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "reservation_attendance_profile_idx" ON "reservation_attendance_records" USING btree ("student_profile_id");--> statement-breakpoint
CREATE INDEX "reservation_attendance_session_idx" ON "reservation_attendance_records" USING btree ("class_session_id");--> statement-breakpoint
CREATE INDEX "reservation_attendance_recorded_at_idx" ON "reservation_attendance_records" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_cancellations_reservation_unique_idx" ON "reservation_cancellations" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "reservation_cancellations_profile_idx" ON "reservation_cancellations" USING btree ("student_profile_id");--> statement-breakpoint
CREATE INDEX "reservation_cancellations_session_idx" ON "reservation_cancellations" USING btree ("class_session_id");--> statement-breakpoint
CREATE INDEX "reservation_cancellations_cancelled_at_idx" ON "reservation_cancellations" USING btree ("cancelled_at");--> statement-breakpoint
CREATE INDEX "reservation_cancellations_sequence_idx" ON "reservation_cancellations" USING btree ("sequence_id");
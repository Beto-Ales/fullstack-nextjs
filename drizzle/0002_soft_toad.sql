CREATE TYPE "public"."class_reservation_origin" AS ENUM('ORDINARY', 'MAKEUP');--> statement-breakpoint
CREATE TYPE "public"."class_reservation_status" AS ENUM('CONFIRMED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."class_session_status" AS ENUM('SCHEDULED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."class_template_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."student_template_assignment_status" AS ENUM('ACTIVE', 'ENDED');--> statement-breakpoint
CREATE TABLE "class_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"class_session_id" text NOT NULL,
	"student_profile_id" text NOT NULL,
	"status" "class_reservation_status" DEFAULT 'CONFIRMED' NOT NULL,
	"origin" "class_reservation_origin" DEFAULT 'ORDINARY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text,
	"local_date" date NOT NULL,
	"starts_at_utc" timestamp with time zone NOT NULL,
	"ends_at_utc" timestamp with time zone NOT NULL,
	"status" "class_session_status" DEFAULT 'SCHEDULED' NOT NULL,
	"max_capacity" integer NOT NULL,
	"is_manually_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"iso_weekday" integer NOT NULL,
	"starts_at_local_time" time NOT NULL,
	"duration_minutes" integer NOT NULL,
	"status" "class_template_status" DEFAULT 'ACTIVE' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"category" text,
	"max_capacity" integer DEFAULT 12 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_capacity_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"class_session_id" text NOT NULL,
	"blocked_spots" integer NOT NULL,
	"reason" text,
	"blocked_by_user_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"contact_phone" text,
	"contact_email" text,
	"admin_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_template_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"student_profile_id" text NOT NULL,
	"template_id" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" "student_template_assignment_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "class_reservations" ADD CONSTRAINT "class_reservations_class_session_id_class_sessions_id_fk" FOREIGN KEY ("class_session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_reservations" ADD CONSTRAINT "class_reservations_student_profile_id_student_profiles_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_template_id_class_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."class_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_capacity_blocks" ADD CONSTRAINT "session_capacity_blocks_class_session_id_class_sessions_id_fk" FOREIGN KEY ("class_session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_capacity_blocks" ADD CONSTRAINT "session_capacity_blocks_blocked_by_user_id_users_id_fk" FOREIGN KEY ("blocked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_template_assignments" ADD CONSTRAINT "student_template_assignments_student_profile_id_student_profiles_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_template_assignments" ADD CONSTRAINT "student_template_assignments_template_id_class_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."class_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "class_reservations_active_unique_idx" ON "class_reservations" USING btree ("class_session_id","student_profile_id") WHERE "class_reservations"."status" = 'CONFIRMED';--> statement-breakpoint
CREATE INDEX "class_reservations_session_idx" ON "class_reservations" USING btree ("class_session_id");--> statement-breakpoint
CREATE INDEX "class_reservations_profile_idx" ON "class_reservations" USING btree ("student_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "class_sessions_template_local_date_unique_idx" ON "class_sessions" USING btree ("template_id","local_date") WHERE "class_sessions"."template_id" is not null;--> statement-breakpoint
CREATE INDEX "class_sessions_starts_at_idx" ON "class_sessions" USING btree ("starts_at_utc");--> statement-breakpoint
CREATE INDEX "class_sessions_status_idx" ON "class_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "class_templates_weekday_idx" ON "class_templates" USING btree ("iso_weekday");--> statement-breakpoint
CREATE INDEX "class_templates_status_idx" ON "class_templates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "session_capacity_blocks_session_idx" ON "session_capacity_blocks" USING btree ("class_session_id");--> statement-breakpoint
CREATE INDEX "session_capacity_blocks_active_idx" ON "session_capacity_blocks" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "student_profiles_user_id_unique_idx" ON "student_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "student_profiles_last_name_idx" ON "student_profiles" USING btree ("last_name");--> statement-breakpoint
CREATE UNIQUE INDEX "student_template_assignments_active_unique_idx" ON "student_template_assignments" USING btree ("student_profile_id","template_id") WHERE "student_template_assignments"."status" = 'ACTIVE' and "student_template_assignments"."effective_to" is null;--> statement-breakpoint
CREATE INDEX "student_template_assignments_student_idx" ON "student_template_assignments" USING btree ("student_profile_id");--> statement-breakpoint
CREATE INDEX "student_template_assignments_template_idx" ON "student_template_assignments" USING btree ("template_id");
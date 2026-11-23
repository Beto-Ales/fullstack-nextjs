CREATE TYPE "public"."student_template_assignment_cancellation_source" AS ENUM('ADMIN_INDIVIDUAL', 'STUDENT_WITHDRAWAL');--> statement-breakpoint
ALTER TYPE "public"."student_template_assignment_status" ADD VALUE 'CANCELLED';--> statement-breakpoint
CREATE TABLE "student_template_assignment_cancellations" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"student_profile_id" text NOT NULL,
	"template_id" text NOT NULL,
	"source" "student_template_assignment_cancellation_source" NOT NULL,
	"cancelled_by_user_id" text NOT NULL,
	"cancelled_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"cancelled_reservation_ids" jsonb NOT NULL,
	"ambiguous_reservation_ids" jsonb NOT NULL,
	"regulation_version_id" text
);
--> statement-breakpoint
ALTER TABLE "student_template_assignment_cancellations" ADD CONSTRAINT "student_template_assignment_cancellations_assignment_id_student_template_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."student_template_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_template_assignment_cancellations" ADD CONSTRAINT "student_template_assignment_cancellations_student_profile_id_student_profiles_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_template_assignment_cancellations" ADD CONSTRAINT "student_template_assignment_cancellations_template_id_class_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."class_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_template_assignment_cancellations" ADD CONSTRAINT "student_template_assignment_cancellations_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_template_assignment_cancellations" ADD CONSTRAINT "student_template_assignment_cancellations_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_template_assignment_cancellations_assignment_unique_idx" ON "student_template_assignment_cancellations" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "student_template_assignment_cancellations_student_idx" ON "student_template_assignment_cancellations" USING btree ("student_profile_id");--> statement-breakpoint
CREATE INDEX "student_template_assignment_cancellations_template_idx" ON "student_template_assignment_cancellations" USING btree ("template_id");
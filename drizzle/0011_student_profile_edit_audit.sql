CREATE TABLE "student_profile_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"student_profile_id" text NOT NULL,
	"edited_by_user_id" text NOT NULL,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation" text NOT NULL,
	"changes" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_profile_edits" ADD CONSTRAINT "student_profile_edits_student_profile_id_student_profiles_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profile_edits" ADD CONSTRAINT "student_profile_edits_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_profile_edits_student_date_idx" ON "student_profile_edits" USING btree ("student_profile_id","edited_at");
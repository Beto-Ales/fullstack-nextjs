CREATE TABLE "student_withdrawals" (
	"student_user_id" text PRIMARY KEY NOT NULL,
	"withdrawn_by_user_id" text NOT NULL,
	"withdrawn_at" timestamp with time zone NOT NULL,
	"ended_assignment_ids" jsonb NOT NULL,
	"released_reservation_ids" jsonb NOT NULL,
	"cancelled_recoveries" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_withdrawals" ADD CONSTRAINT "student_withdrawals_student_user_id_users_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_withdrawals" ADD CONSTRAINT "student_withdrawals_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
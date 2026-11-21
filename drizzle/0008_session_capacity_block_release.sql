ALTER TABLE "session_capacity_blocks" ADD COLUMN "released_by_user_id" text;--> statement-breakpoint
ALTER TABLE "session_capacity_blocks" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_capacity_blocks" ADD COLUMN "release_reason" text;--> statement-breakpoint
ALTER TABLE "session_capacity_blocks" ADD CONSTRAINT "session_capacity_blocks_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
CREATE TYPE "public"."credit_movement_type" AS ENUM('AUTO_CANCELLATION_GRANT', 'MANUAL_GRANT', 'MANUAL_WITHDRAWAL', 'EXPIRATION', 'RECOVERY_CONSUMPTION', 'RECOVERY_REFUND');--> statement-breakpoint
CREATE TABLE "credit_ledger_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"student_profile_id" text NOT NULL,
	"movement_type" "credit_movement_type" NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"reason" text,
	"class_session_id" text,
	"admin_user_id" text,
	"source_cancellation_id" text,
	"source_movement_id" text,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD CONSTRAINT "credit_ledger_movements_student_profile_id_student_profiles_id_fk" FOREIGN KEY ("student_profile_id") REFERENCES "public"."student_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD CONSTRAINT "credit_ledger_movements_class_session_id_class_sessions_id_fk" FOREIGN KEY ("class_session_id") REFERENCES "public"."class_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD CONSTRAINT "credit_ledger_movements_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD CONSTRAINT "credit_ledger_movements_source_cancellation_id_reservation_cancellations_id_fk" FOREIGN KEY ("source_cancellation_id") REFERENCES "public"."reservation_cancellations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_student_created_idx" ON "credit_ledger_movements" USING btree ("student_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_expires_idx" ON "credit_ledger_movements" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_unique_idx" ON "credit_ledger_movements" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_auto_cancellation_unique_idx" ON "credit_ledger_movements" USING btree ("source_cancellation_id") WHERE "credit_ledger_movements"."movement_type" = 'AUTO_CANCELLATION_GRANT' and "credit_ledger_movements"."source_cancellation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_expiration_source_unique_idx" ON "credit_ledger_movements" USING btree ("source_movement_id") WHERE "credit_ledger_movements"."movement_type" = 'EXPIRATION' and "credit_ledger_movements"."source_movement_id" is not null;
CREATE TABLE "academic_regulations" (
	"id" text PRIMARY KEY NOT NULL,
	"effective_from" date NOT NULL,
	"cancellation_notice_days" integer NOT NULL,
	"monthly_cancellation_credits" integer NOT NULL,
	"monthly_recoveries" integer NOT NULL,
	"credit_expiration_months" integer NOT NULL,
	"max_class_capacity" integer NOT NULL,
	"previous_version_id" text,
	"published_by_user_id" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changes" jsonb NOT NULL,
	CONSTRAINT "academic_regulations_effective_from_unique" UNIQUE("effective_from")
);
--> statement-breakpoint
CREATE TABLE "class_session_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"class_session_id" text NOT NULL,
	"regulation_version_id" text NOT NULL,
	"edited_by_user_id" text,
	"edited_at" timestamp with time zone NOT NULL,
	"starts_at_utc" timestamp with time zone NOT NULL,
	"ends_at_utc" timestamp with time zone NOT NULL,
	"max_capacity" integer NOT NULL,
	"status" "class_session_status" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "class_reservations" ADD COLUMN "regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "class_reservations" ADD COLUMN "cancellation_regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD COLUMN "regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "class_templates" ADD COLUMN "regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD COLUMN "regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "reservation_attendance_records" ADD COLUMN "regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD COLUMN "regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "session_capacity_blocks" ADD COLUMN "regulation_version_id" text;--> statement-breakpoint
ALTER TABLE "academic_regulations" ADD CONSTRAINT "academic_regulations_previous_version_id_academic_regulations_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_regulations" ADD CONSTRAINT "academic_regulations_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_edits" ADD CONSTRAINT "class_session_edits_class_session_id_class_sessions_id_fk" FOREIGN KEY ("class_session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_edits" ADD CONSTRAINT "class_session_edits_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_session_edits" ADD CONSTRAINT "class_session_edits_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "class_session_edits_session_idx" ON "class_session_edits" USING btree ("class_session_id","edited_at");--> statement-breakpoint
ALTER TABLE "class_reservations" ADD CONSTRAINT "class_reservations_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_reservations" ADD CONSTRAINT "class_reservations_cancellation_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("cancellation_regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_templates" ADD CONSTRAINT "class_templates_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD CONSTRAINT "credit_ledger_movements_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_attendance_records" ADD CONSTRAINT "reservation_attendance_records_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_cancellations" ADD CONSTRAINT "reservation_cancellations_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_capacity_blocks" ADD CONSTRAINT "session_capacity_blocks_regulation_version_id_academic_regulations_id_fk" FOREIGN KEY ("regulation_version_id") REFERENCES "public"."academic_regulations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "academic_regulations" (
  "id", "effective_from", "cancellation_notice_days", "monthly_cancellation_credits",
  "monthly_recoveries", "credit_expiration_months", "max_class_capacity", "changes"
) VALUES (
  'initial', '0001-01-01', 7, 2, 2, 6, 12,
  '{
    "cancellationNoticeDays": {"previous": null, "next": 7},
    "monthlyCancellationCredits": {"previous": null, "next": 2},
    "monthlyRecoveries": {"previous": null, "next": 2},
    "creditExpirationMonths": {"previous": null, "next": 6},
    "maxClassCapacity": {"previous": null, "next": 12}
  }'::jsonb
);
--> statement-breakpoint
CREATE FUNCTION "reject_academic_regulation_changes"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published academic regulations cannot be changed or deleted' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "academic_regulations_immutable"
BEFORE UPDATE OR DELETE ON "academic_regulations"
FOR EACH ROW EXECUTE FUNCTION "reject_academic_regulation_changes"();

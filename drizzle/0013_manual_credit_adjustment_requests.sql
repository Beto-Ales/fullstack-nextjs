CREATE TABLE "manual_credit_adjustment_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_user_id" text NOT NULL,
	"payload_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD COLUMN "manual_request_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD CONSTRAINT "credit_ledger_movements_manual_request_id_manual_credit_adjustment_requests_id_fk" FOREIGN KEY ("manual_request_id") REFERENCES "public"."manual_credit_adjustment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_manual_request_idx" ON "credit_ledger_movements" USING btree ("manual_request_id") WHERE "credit_ledger_movements"."manual_request_id" is not null;--> statement-breakpoint
ALTER TABLE "credit_ledger_movements" ADD CONSTRAINT "credit_ledger_manual_request_type_check" CHECK ("credit_ledger_movements"."manual_request_id" is null or "credit_ledger_movements"."movement_type" in ('MANUAL_GRANT', 'MANUAL_WITHDRAWAL'));
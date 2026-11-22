CREATE TABLE "login_attempt_budgets" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "login_attempt_budgets_attempts_check" CHECK ("login_attempt_budgets"."attempts" between 1 and 600)
);
--> statement-breakpoint
CREATE INDEX "login_attempt_budgets_expires_at_idx" ON "login_attempt_budgets" USING btree ("expires_at");
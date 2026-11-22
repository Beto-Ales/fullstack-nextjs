import "server-only";

import { createHmac } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";

import { normalizeEmail } from "@/src/domain/auth/email";
import type { db } from "@/src/infrastructure/db/client";
import { loginAttemptBudgets } from "@/src/infrastructure/db/schema/login-attempt-budgets";
import { LOGIN_GLOBAL_MAX_ATTEMPTS, parseLoginRateLimitConfig } from "@/src/infrastructure/env";

const GLOBAL_BUDGET_KEY = "*";
const LOGIN_BUDGET_LOCK = 903000045;

type LoginAttemptReservation = { key: string; expiresAtEpoch: string };
type LoginBudgetTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function buildLoginBudgetKey(email: string, hmacKey: string): string {
  return createHmac("sha256", Buffer.from(hmacKey, "hex"))
    .update(`login:${normalizeEmail(email)}`)
    .digest("hex");
}

async function withLoginBudgetLock<T>(database: typeof db, run: (tx: LoginBudgetTransaction) => Promise<T>): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    // Take the lock before reading either budget or sampling the database clock.
    await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_BUDGET_LOCK}::bigint)`);
    return run(tx);
  }, { isolationLevel: "read committed" });
}

export async function reserveLoginAttempt(database: typeof db, normalizedEmail: string): Promise<LoginAttemptReservation | null> {
  const config = parseLoginRateLimitConfig(process.env);
  const identityKey = buildLoginBudgetKey(normalizedEmail, config.AUTH_RATE_LIMIT_HMAC_KEY);

  return withLoginBudgetLock(database, async (tx) => {
    const { rows } = await tx.execute<LoginAttemptReservation & { attempts: number }>(sql`
      with budgets(key, max_attempts) as (
        values (${GLOBAL_BUDGET_KEY}::text, ${LOGIN_GLOBAL_MAX_ATTEMPTS}::int),
               (${identityKey}::text, ${config.AUTH_RATE_LIMIT_MAX_ATTEMPTS}::int)
      ), current_budgets as (
        select budgets.key, budgets.max_attempts, coalesce(existing.attempts, 0) as attempts,
          coalesce(existing.expires_at, statement_timestamp() +
            make_interval(mins => ${config.AUTH_RATE_LIMIT_WINDOW_MINUTES}::int)) as expires_at
        from budgets
        left join ${loginAttemptBudgets} as existing
          on existing.key = budgets.key and existing.expires_at > statement_timestamp()
      )
      insert into ${loginAttemptBudgets} (key, attempts, expires_at)
        select key, attempts + 1, expires_at from current_budgets
        where not exists (select 1 from current_budgets where attempts >= max_attempts)
        on conflict (key) do update set attempts = excluded.attempts, expires_at = excluded.expires_at
        returning key, attempts, extract(epoch from expires_at)::text as "expiresAtEpoch"
    `);

    const globalBudget = rows.find(({ key }) => key === GLOBAL_BUDGET_KEY);
    if (globalBudget?.attempts === 1) {
      // New identities can only be stored when the global budget admits a request.
      await tx.delete(loginAttemptBudgets).where(lte(loginAttemptBudgets.expiresAt, sql`statement_timestamp()`));
    }
    const identityBudget = rows.find(({ key }) => key === identityKey);
    return identityBudget ? { key: identityBudget.key, expiresAtEpoch: identityBudget.expiresAtEpoch } : null;
  });
}

export async function releaseLoginIdentityAttempt(database: typeof db, reservation: LoginAttemptReservation): Promise<void> {
  await withLoginBudgetLock(database, async (tx) => {
    const sameActiveWindow = and(
      eq(loginAttemptBudgets.key, reservation.key),
      sql`extract(epoch from ${loginAttemptBudgets.expiresAt}) = ${reservation.expiresAtEpoch}::numeric`,
      gt(loginAttemptBudgets.expiresAt, sql`statement_timestamp()`),
    );
    const deleted = await tx.delete(loginAttemptBudgets)
      .where(and(sameActiveWindow, eq(loginAttemptBudgets.attempts, 1)))
      .returning({ key: loginAttemptBudgets.key });
    if (deleted.length === 0) {
      await tx.update(loginAttemptBudgets).set({ attempts: sql`${loginAttemptBudgets.attempts} - 1` })
        .where(and(sameActiveWindow, gt(loginAttemptBudgets.attempts, 1)));
    }
  });
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { INVALID_CREDENTIALS_MESSAGE } from "@/src/application/auth/errors";
import {
  buildLoginBudgetKey, releaseLoginIdentityAttempt, reserveLoginAttempt,
} from "@/src/infrastructure/security/auth-rate-limit";
import { hashPassword } from "@/src/infrastructure/security/password";
import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

const credentials = { email: "active@example.com", password: "synthetic-login-password" };
const invalidCredentials = { code: "invalid_credentials", message: INVALID_CREDENTIALS_MESSAGE };
const exec = promisify(execFile);
const require = createRequire(import.meta.url);

describe("login budgets and sessions (PostgreSQL)", () => {
  let client: Awaited<ReturnType<typeof createVerifiedTestClient>>;
  let db: typeof import("@/src/infrastructure/db/client").db;
  let auth: typeof import("./auth-service");
  let hash: string;

  const keyFor = (email: string) => buildLoginBudgetKey(email, process.env.AUTH_RATE_LIMIT_HMAC_KEY!);
  const consume = async (email = credentials.email) => Boolean(await reserveLoginAttempt(db, email));

  async function readBudgets() {
    return (await client.query<{ key: string; attempts: number; expires_at: Date }>(
      "select key, attempts, expires_at from login_attempt_budgets order by key",
    )).rows;
  }

  async function seedUser(email = credentials.email, status: "ACTIVE" | "DISABLED" = "ACTIVE") {
    const id = randomUUID();
    await client.query(`insert into users (id,email,email_normalized,password_hash,role,status)
      values ($1,$2,$2,$3,'STUDENT',$4)`, [id, email, hash, status]);
    return id;
  }

  beforeAll(async () => {
    client = await createVerifiedTestClient();
    ({ db } = await import("@/src/infrastructure/db/client"));
    auth = await import("./auth-service");
    hash = await hashPassword(credentials.password);
  });
  beforeEach(async () => { await resetTestDatabase(client); });
  afterAll(async () => { await client?.end(); });

  it("shares admissions across independent application processes, including after a restart", async () => {
    const runner = createRequire(require.resolve("vitest/package.json")).resolve("vite-node/vite-node.mjs");
    const env = { ...process.env, DATABASE_URL: "" };
    async function runProcess() {
      const result = await exec(process.execPath, [
        runner, "--config", "vitest.config.ts", "src/test-support/login-attempt-process.ts", "--", credentials.email,
      ], { env, timeout: 12_000, windowsHide: true }).catch(() => {
        throw new Error("The independent login process failed on the verified test database.");
      });
      return JSON.parse(result.stdout) as { pid: number; admitted: boolean };
    }

    for (let count = 0; count < 3; count++) expect(await consume()).toBe(true);
    const first = await runProcess();
    const restarted = await runProcess();
    expect(first).toMatchObject({ admitted: true });
    expect(restarted).toMatchObject({ admitted: true });
    expect(new Set([process.pid, first.pid, restarted.pid]).size).toBe(3);
    await expect(consume()).resolves.toBe(false);
    expect(await readBudgets()).toEqual([
      { key: "*", attempts: 5, expires_at: expect.any(Date) },
      { key: keyFor(credentials.email), attempts: 5, expires_at: expect.any(Date) },
    ]);
  }, 30_000);

  it("admits only one last attempt while two independent connections are observed waiting", async () => {
    for (let count = 0; count < 4; count++) expect(await consume()).toBe(true);
    const gate = await createVerifiedTestClient();
    const attempts: Promise<boolean>[] = [];
    try {
      await gate.query("begin");
      await gate.query("select pg_advisory_xact_lock(903000045::bigint)");
      attempts.push(consume(), consume(" ACTIVE@EXAMPLE.COM "));
      const result = Promise.allSettled(attempts);
      await expect.poll(async () => (await client.query(`select pid from pg_stat_activity
        where datname=current_database() and wait_event='advisory' and query like 'select pg_advisory_xact_lock%'`)).rowCount,
      { interval: 25, timeout: 3000 }).toBe(2);
      await gate.query("commit");
      expect(await result).toEqual(expect.arrayContaining([
        { status: "fulfilled", value: true }, { status: "fulfilled", value: false },
      ]));
      expect((await readBudgets()).map(({ attempts }) => attempts)).toEqual([5, 5]);
    } finally {
      await gate.end();
      await Promise.allSettled(attempts);
    }
  });

  it("rejects a saturated identity without spending other identities' global budget", async () => {
    for (let count = 0; count < 5; count++) expect(await consume()).toBe(true);
    const before = await readBudgets();
    for (let count = 0; count < 3; count++) await expect(consume()).resolves.toBe(false);
    expect(await readBudgets()).toEqual(before);
    await expect(consume("unrelated@example.com")).resolves.toBe(true);
    expect((await readBudgets())[0].attempts).toBe(6);
  });

  it("enforces the global budget across distinct identities and creates no rows after exhaustion", async () => {
    await client.query("insert into login_attempt_budgets values ('*',599,clock_timestamp()+interval '15 minutes')");
    const attempts = await Promise.all([consume("one@example.com"), consume("two@example.com")]);
    expect(attempts.sort()).toEqual([false, true]);
    await expect(consume("three@example.com")).resolves.toBe(false);
    const budgets = await readBudgets();
    expect(budgets.map(({ attempts }) => attempts)).toEqual([600, 1]);
  });

  it("starts a new window after expiry and prunes only expired rows when the global window renews", async () => {
    for (let count = 0; count < 5; count++) expect(await consume()).toBe(true);
    await expect(consume()).resolves.toBe(false);
    const activeKey = keyFor("survivor@example.com");
    const expiredKey = keyFor("expired@example.com");
    await client.query(`insert into login_attempt_budgets values
      ($1,1,clock_timestamp()+interval '10 minutes'), ($2,1,clock_timestamp()-interval '1 minute')`, [activeKey, expiredKey]);
    await client.query(`update login_attempt_budgets set expires_at=clock_timestamp()-interval '1 second'
      where key in ('*',$1)`, [keyFor(credentials.email)]);

    await expect(consume()).resolves.toBe(true);
    const budgets = await readBudgets();
    expect(budgets.map(({ key }) => key)).toEqual(["*", activeKey, keyFor(credentials.email)].sort());
    expect(budgets.map(({ attempts }) => attempts)).toEqual([1, 1, 1]);
    expect(budgets[0].expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("treats wrong passwords, disabled accounts and unknown emails identically on both sides of the threshold", async () => {
    await seedUser();
    await seedUser("disabled@example.com", "DISABLED");
    const attempts = [
      { ...credentials, password: "wrong-synthetic-password" },
      { ...credentials, email: "disabled@example.com" },
      { ...credentials, email: "unknown@example.com" },
    ];
    for (const input of attempts) {
      for (let count = 0; count < 5; count++) {
        await expect(auth.authenticateUser(input)).rejects.toMatchObject(invalidCredentials);
      }
      await expect(auth.authenticateUser(input)).rejects.toMatchObject({ code: "too_many_attempts" });
    }
    expect((await client.query("select id from sessions")).rowCount).toBe(0);
    const budgets = await readBudgets();
    expect(budgets.map(({ key }) => key)).toEqual(["*", ...attempts.map(({ email }) => keyFor(email))].sort());
    expect(budgets.map(({ attempts }) => attempts)).toEqual([15, 5, 5, 5]);
  }, 15_000);

  it("returns only the successful password check's identity opportunity and preserves other attempts", async () => {
    const userId = await seedUser();
    await expect(auth.authenticateUser(credentials)).resolves.toMatchObject({ userId });
    expect((await readBudgets()).map(({ key, attempts }) => ({ key, attempts }))).toEqual([{ key: "*", attempts: 1 }]);

    await expect(auth.authenticateUser({ ...credentials, password: "wrong-synthetic-password" })).rejects.toMatchObject(invalidCredentials);
    const [global, identity] = await readBudgets();
    await expect(auth.authenticateUser(credentials)).resolves.toMatchObject({ userId });
    expect(await readBudgets()).toEqual([{ ...global, attempts: 3 }, identity]);
  });

  it("ignores a release from an expired window after another request starts a new one", async () => {
    const key = keyFor(credentials.email);
    await client.query(`insert into login_attempt_budgets values
      ($1,1,clock_timestamp()+interval '1 minute')`, [key]);
    const stale = await reserveLoginAttempt(db, credentials.email);
    expect(stale).not.toBeNull();
    await client.query(`update login_attempt_budgets set expires_at=clock_timestamp()-interval '1 second' where key=$1`, [key]);
    await expect(consume()).resolves.toBe(true);
    const before = await readBudgets();

    await releaseLoginIdentityAttempt(db, stale!);
    expect(await readBudgets()).toEqual(before);
    expect(before.map(({ attempts }) => attempts)).toEqual([2, 1]);
  });

  it("fails closed with no partial budget write and leaves existing sessions usable and revocable", async () => {
    const userId = await seedUser();
    const { sessionToken } = await auth.authenticateUser({ ...credentials, email: " ACTIVE@EXAMPLE.COM " });
    const before = await readBudgets();
    await client.query(`alter table login_attempt_budgets add constraint h05_test_write_failure check (key = '*') not valid`);
    try {
      await expect(auth.authenticateUser(credentials)).rejects.toMatchObject({ cause: { code: "23514" } });
      expect(await readBudgets()).toEqual(before);
      expect((await client.query("select id from sessions")).rowCount).toBe(1);
      await expect(auth.getAuthenticatedUserFromSessionToken(sessionToken)).resolves.toMatchObject({ userId });
      await auth.revokeSession(sessionToken);
      await expect(auth.getAuthenticatedUserFromSessionToken(sessionToken)).resolves.toBeNull();
    } finally {
      await client.query("alter table login_attempt_budgets drop constraint h05_test_write_failure");
    }
  });

  it("refuses to issue a session after waiting for a concurrent account deactivation to commit", async () => {
    const userId = await seedUser();
    const gate = await createVerifiedTestClient();
    try {
      const { rows: [{ pid }] } = await gate.query<{ pid: number }>("select pg_backend_pid() as pid");
      await gate.query("begin");
      await gate.query("update users set status='DISABLED', deactivated_at=clock_timestamp() where id=$1", [userId]);
      const login = auth.authenticateUser(credentials);
      const result = Promise.allSettled([login]);
      try {
        await expect.poll(async () => (await client.query(`select pid from pg_stat_activity
          where datname=current_database() and $1=any(pg_blocking_pids(pid)) and query ilike '%for update%'`, [pid])).rowCount,
        { interval: 25, timeout: 3000 }).toBe(1);
        expect((await readBudgets()).map(({ attempts }) => attempts)).toEqual([1]);
        await gate.query("commit");
        expect(await result).toEqual([{ status: "rejected", reason: expect.objectContaining(invalidCredentials) }]);
        expect((await client.query("select id from sessions where user_id=$1", [userId])).rowCount).toBe(0);
      } finally {
        await gate.query("rollback");
        await result;
      }
    } finally {
      await gate.end();
    }
  });
});

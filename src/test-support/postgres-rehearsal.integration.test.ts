import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import { expect, it } from "vitest";

import { checkDatabaseState, expectedJournal, inspectExplicit, migrationsFolder, readDatabaseState, schemaFingerprint } from "../../scripts/db-inspection.mjs";
import { assertTestConnection, openVerifiedTestConnection } from "../../scripts/postgres-test-guard.mjs";
import { withDisposablePostgres } from "../../scripts/run-postgres-tests.mjs";
import * as schema from "@/src/infrastructure/db/schema";
import { reserveLoginAttempt } from "@/src/infrastructure/security/auth-rate-limit";
import { createVerifiedTestClient } from "@/src/test-support/postgres-test-db";

type Rehearsal = Awaited<ReturnType<typeof openVerifiedTestConnection>>;
type Row = Record<string, unknown>;
const migrations = readMigrationFiles({ migrationsFolder });

async function withRehearsal(action: (resource: Rehearsal, env: Record<string, string | undefined>) => Promise<void>) {
  const inherited = { ...process.env };
  delete inherited.TEST_DATABASE_URL;
  delete inherited.POSTGRES_TEST_RUN;
  await withDisposablePostgres("rehearsal", async (env) => {
    const resource = await openVerifiedTestConnection(env, ["rehearsal"]);
    try {
      await action(resource, env);
    } finally {
      await resource.client.end();
    }
  }, inherited);
}

function readState({ client, run }: Rehearsal) {
  return readDatabaseState(client, { database: run.database, systemId: run.systemId });
}

async function applyMigrations({ client, run }: Rehearsal, entries = migrations) {
  await assertTestConnection(client, run);
  // The PostgreSQL dialect accepts the node-postgres session used by the public migrator.
  const session = drizzle(client)._.session as unknown as Parameters<PgDialect["migrate"]>[1];
  await new PgDialect().migrate(entries, session, { migrationsFolder });
}

function postgresTool(run: Rehearsal["run"], tool: string, args: string[], input?: Buffer): Buffer {
  return execFileSync("docker", ["exec", "-i", run.containerId, tool, ...args], {
    input, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
}

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function socketArgs(run: Rehearsal["run"]) {
  return ["--host=/var/run/postgresql", "--port=5432", "--no-password", `--username=${run.user}`, `--dbname=${run.database}`];
}

async function backup({ client, run }: Rehearsal) {
  await assertTestConnection(client, run);
  expect(postgresTool(run, "pg_dump", ["--version"]).toString()).toMatch(/^pg_dump \(PostgreSQL\) 15\./);
  const bytes = postgresTool(run, "pg_dump", [...socketArgs(run), "--format=custom", "--exclude-schema=test_provisioning"]);
  return { bytes, sha256: digest(bytes) };
}

async function restore(resource: Rehearsal, archive: Awaited<ReturnType<typeof backup>>) {
  const { client, run } = resource;
  await assertTestConnection(client, run);
  const state = await readState(resource);
  if (state.identity.journalExists || schemaFingerprint(state.catalog) !== schemaFingerprint([["schema", "public", ""]])) {
    throw new Error("Restore requires the verified empty rehearsal database.");
  }
  if (digest(archive.bytes) !== archive.sha256) throw new Error("Archive checksum mismatch.");
  expect(postgresTool(run, "pg_restore", ["--version"]).toString()).toMatch(/^pg_restore \(PostgreSQL\) 15\./);
  let contents: string;
  try {
    contents = postgresTool(run, "pg_restore", ["--list"], archive.bytes).toString();
  } catch {
    throw new Error("Invalid PostgreSQL archive.");
  }
  expect(contents).toMatch(/TABLE DATA drizzle __drizzle_migrations /);
  expect(contents).toMatch(/TABLE DATA public credit_ledger_movements /);
  expect(contents).not.toContain("test_provisioning");
  postgresTool(run, "pg_restore", [...socketArgs(run), "--single-transaction", "--no-owner", "--no-acl"], archive.bytes);
}

async function seedHistory(client: Client, initial: 5 | 6) {
  await client.query(`
    insert into app_metadata (key,value) values ('rehearsal','{"synthetic":true}');
    insert into users (id,email,email_normalized,password_hash,role,status,deactivated_at) values
      ('active','active@example.invalid','active@example.invalid','synthetic-hash','STUDENT','ACTIVE',null),
      ('disabled','disabled@example.invalid','disabled@example.invalid','synthetic-hash','STUDENT','DISABLED','2024-04-01Z'),
      ('admin','admin@example.invalid','admin@example.invalid','synthetic-hash','SUPER_ADMIN','ACTIVE',null);
    insert into sessions (id,user_id,token_hash,expires_at)
      values ('login-session','active','synthetic-token-digest','2099-01-01Z');
    insert into student_profiles (id,user_id,first_name,last_name) values
      ('profile','active','Synthetic','Active'),('disabled-profile','disabled','Synthetic','Disabled');
    insert into class_templates (id,name,iso_weekday,starts_at_local_time,duration_minutes,effective_from)
      values ('weekly','Synthetic template',1,'18:00',60,'2024-01-01');
    insert into student_template_assignments (id,student_profile_id,template_id,effective_from)
      values ('habitual','profile','weekly','2024-01-01');
    insert into class_sessions (id,template_id,local_date,starts_at_utc,ends_at_utc,status,max_capacity)
      values ('cancel-session','weekly','2024-03-04','2024-03-04 17:00Z','2024-03-04 18:00Z','COMPLETED',12),
             ('attend-session','weekly','2024-03-11','2024-03-11 17:00Z','2024-03-11 18:00Z','COMPLETED',12),
             ('makeup-session',null,'2024-03-12','2024-03-12 17:00Z','2024-03-12 18:00Z','COMPLETED',10);
    insert into session_capacity_blocks (id,class_session_id,blocked_spots,blocked_by_user_id)
      values ('block','makeup-session',1,'admin');
    insert into class_reservations (id,class_session_id,student_profile_id,status,origin,cancelled_at,cancelled_by_user_id)
      values ('cancelled','cancel-session','profile','CANCELLED','ORDINARY','2024-02-20Z','active'),
             ('attended','attend-session','profile','CONFIRMED','ORDINARY',null,null),
             ('makeup','makeup-session','profile','CONFIRMED','MAKEUP',null,null);
    insert into reservation_cancellations (id,reservation_id,student_profile_id,class_session_id,cancelled_by_user_id,
      cancelled_at,cancellation_type,hours_before_start,meets_seven_day_rule,is_habitual_reservation,
      sequence_id,sequence_position,is_third_cancellation,can_generate_credit_candidate)
      values ('cancellation','cancelled','profile','cancel-session','active','2024-02-20Z','ON_TIME',300,true,true,'sequence',3,true,true);
    insert into reservation_attendance_records (id,reservation_id,student_profile_id,class_session_id,outcome,source,
      recorded_by_user_id,recorded_at)
      values ('attendance','attended','profile','attend-session','ATTENDED','MANUAL','admin','2024-03-11 18:00Z');
    insert into credit_ledger_movements (id,student_profile_id,movement_type,amount,expires_at,class_session_id,
      admin_user_id,source_cancellation_id,source_movement_id,idempotency_key,related_reservation_id,source_grant_movement_id)
      values ('grant','profile','AUTO_CANCELLATION_GRANT',1,'2099-01-01Z','cancel-session',null,'cancellation',null,'synthetic-grant',null,null),
             ('debit','profile','RECOVERY_CONSUMPTION',-1,null,'makeup-session',null,null,'grant','synthetic-debit','makeup','grant'),
             ('manual','profile','MANUAL_GRANT',2,'2099-01-01Z',null,'admin',null,null,'synthetic-manual',null,null);
  `);
  if (initial === 6) {
    await client.query(`
      update class_sessions set regulation_version_id='initial' where id='attend-session';
      update reservation_attendance_records set regulation_version_id='initial' where id='attendance';
      insert into class_session_edits (id,class_session_id,regulation_version_id,edited_by_user_id,edited_at,
        starts_at_utc,ends_at_utc,max_capacity,status)
        values ('edit','attend-session','initial','admin','2024-03-10Z','2024-03-11 17:00Z','2024-03-11 18:00Z',12,'COMPLETED');
    `);
  }
}

const regulationColumns = {
  class_reservations: { regulation_version_id: null, cancellation_regulation_version_id: null },
  class_sessions: { regulation_version_id: null },
  class_templates: { regulation_version_id: null },
  session_capacity_blocks: { regulation_version_id: null },
  credit_ledger_movements: { regulation_version_id: null },
  reservation_attendance_records: { regulation_version_id: null },
  reservation_cancellations: { regulation_version_id: null },
};
const finalColumns = {
  academic_regulations: { max_eligible_consecutive_cancellations: null },
  class_reservations: { created_by_user_id: null },
  session_capacity_blocks: { released_by_user_id: null, released_at: null, release_reason: null },
  credit_ledger_movements: { manual_request_id: null },
  reservation_cancellations: { decision_source: null, administrative_reason: null, sequence_pending: false, credit_resolution: null },
};

async function history(client: Client, initial: 5 | 6) {
  const tables = ["app_metadata", "users", "sessions", "student_profiles", "student_template_assignments", ...Object.keys(regulationColumns)];
  if (initial === 6) tables.push("academic_regulations", "class_session_edits");
  const state: Record<string, Row[]> = {};
  for (const table of tables) {
    const key = table === "app_metadata" ? "key" : "id";
    state[table] = (await client.query<{ value: Row }>(`select to_jsonb(record) as value from "${table}" record order by ${key}`)).rows
      .map(({ value }) => value);
  }
  return state;
}

async function assertHistoricalState(client: Client, initial: 5 | 6, before: Awaited<ReturnType<typeof history>>) {
  const expected = Object.fromEntries(Object.entries(before).map(([table, rows]) => [
    table,
    rows.map((row) => ({
      ...row,
      ...(initial === 5 ? regulationColumns[table as keyof typeof regulationColumns] : {}),
      ...finalColumns[table as keyof typeof finalColumns],
    })),
  ]));
  expect(await history(client, initial)).toEqual(expected);
  expect((await client.query(`select id,effective_from::text, published_by_user_id, previous_version_id,
    cancellation_notice_days, monthly_cancellation_credits, monthly_recoveries, credit_expiration_months,
    max_class_capacity, max_eligible_consecutive_cancellations
    from academic_regulations`)).rows).toEqual([{
    id: "initial", effective_from: "0001-01-01", published_by_user_id: null, previous_version_id: null,
    cancellation_notice_days: 7, monthly_cancellation_credits: 2, monthly_recoveries: 2, credit_expiration_months: 6,
    max_class_capacity: 12, max_eligible_consecutive_cancellations: null,
  }]);
  expect((await client.query(`select sum(amount)::int as available,
    -sum(amount) filter (where movement_type='RECOVERY_CONSUMPTION') as consumed
    from credit_ledger_movements where student_profile_id='profile'`)).rows).toEqual([{ available: 2, consumed: "1" }]);
  for (const table of ["student_withdrawals", "student_profile_edits", "manual_credit_adjustment_requests", "login_attempt_budgets"]) {
    expect((await client.query(`select 1 from "${table}"`)).rowCount).toBe(0);
  }
}

async function expectConstraint(client: Client, statement: string, code: string) {
  await client.query("begin");
  try {
    await expect(client.query(statement)).rejects.toMatchObject({ code });
  } finally {
    await client.query("rollback");
  }
}

async function verifyNewAuditAndRequest(client: Client) {
  await client.query("begin");
  try {
    await client.query(`insert into student_profile_edits (id,student_profile_id,edited_by_user_id,operation,changes)
      values ('valid-edit','profile','admin','UPDATE_STUDENT_DETAILS','{}');
      insert into manual_credit_adjustment_requests (id,admin_user_id,payload_hash)
      values ('12345678-1234-1234-1234-123456789abc','admin','synthetic-hash');
      insert into credit_ledger_movements (id,student_profile_id,movement_type,amount,idempotency_key,manual_request_id)
      values ('valid-adjustment','profile','MANUAL_GRANT',1,'new-request','12345678-1234-1234-1234-123456789abc')`);
    expect((await client.query("select id from student_profile_edits")).rows).toEqual([{ id: "valid-edit" }]);
    expect((await client.query(`select m.id, r.admin_user_id from credit_ledger_movements m
      join manual_credit_adjustment_requests r on r.id=m.manual_request_id`)).rows)
      .toEqual([{ id: "valid-adjustment", admin_user_id: "admin" }]);
    await expect(client.query(`insert into manual_credit_adjustment_requests (id,admin_user_id,payload_hash)
      values ('12345678-1234-1234-1234-123456789abc','admin','different')`)).rejects.toMatchObject({ code: "23505" });
  } finally {
    await client.query("rollback");
  }
}

async function finalSchema() {
  const clean = await createVerifiedTestClient();
  try {
    const marker = (await clean.query("select system_identifier::text as id from pg_control_system()")).rows[0];
    const state = await readDatabaseState(clean, { database: clean.database, systemId: marker.id });
    const report = checkDatabaseState(state);
    expect(report).toMatchObject({ pending: [], errors: [] });
    return state.catalog;
  } finally {
    await clean.end();
  }
}

it("checks each migration prefix and rejects schema drift without a journal change", async () => {
  await withRehearsal(async (resource) => {
    const expected = expectedJournal();
    for (const [index, item] of expected.entries()) {
      await applyMigrations(resource, migrations.slice(0, index + 1));
      expect(checkDatabaseState(await readState(resource))).toMatchObject({ last: item.tag, errors: [] });
    }
    await resource.client.query("alter table login_attempt_budgets drop constraint login_attempt_budgets_attempts_check");
    expect(checkDatabaseState(await readState(resource))).toMatchObject({ last: expected.at(-1)?.tag, pending: [],
      errors: [expect.stringContaining("catálogo")] });
  });
}, 30_000);

it("rejects a persistent port and checks explicit cluster identity and startup configuration", async () => {
  await withRehearsal(async (resource, env) => {
    const persistent = new URL(resource.run.connectionString);
    persistent.port = "5432";
    await expect(openVerifiedTestConnection({ ...env, TEST_DATABASE_URL: persistent.href }, ["rehearsal"])).rejects.toThrow("aislado");

    await applyMigrations(resource);
    const target = {
      DATABASE_INSPECTION_URL: resource.run.connectionString, DATABASE_URL: resource.run.connectionString,
      DB_EXPECTED_NAME: resource.run.database, DB_EXPECTED_SYSTEM_ID: resource.run.systemId,
    };
    await expect(inspectExplicit({ ...target, DB_EXPECTED_SYSTEM_ID: "0" }, true)).rejects.toThrow("identidad");
    await expect(inspectExplicit({ ...target, DATABASE_URL: persistent.href }, true)).rejects.toThrow("difiere");
    await expect(inspectExplicit({ ...target, DATABASE_INSPECTION_URL: undefined }, true)).rejects.toThrow("explícita");
    const state = await inspectExplicit(target, true);
    expect(state.identity.readOnly).toBe(true);
    expect(checkDatabaseState(state, { ready: true }).errors).toEqual([expect.stringContaining("AUTH_RATE_LIMIT_HMAC_KEY")]);
    expect(checkDatabaseState(state, {
      ready: true, hmacKey: "ab".repeat(32), maxAttempts: "101", windowMinutes: "0",
    }).errors).toEqual([expect.stringContaining("MAX_ATTEMPTS"), expect.stringContaining("WINDOW_MINUTES")]);
    expect(checkDatabaseState({ ...state, journal: state.journal.slice(1) }).errors).toEqual([expect.stringContaining("Journal")]);
  });
}, 30_000);

it.each([5, 6] as const)("upgrades synthetic history from 000%i and matches a clean installation at the journal head", async (initial) => {
  const cleanCatalog = await finalSchema();
  let archive: Awaited<ReturnType<typeof backup>> | undefined;
  let originalJournal: Awaited<ReturnType<typeof readState>>["journal"];
  let originalHistory: Awaited<ReturnType<typeof history>>;
  let originalCatalog: Awaited<ReturnType<typeof readState>>["catalog"];
  await withRehearsal(async (resource, env) => {
    const { client, run } = resource;
    await applyMigrations(resource, migrations.slice(0, initial + 1));
    await seedHistory(client, initial);
    const start = await readState(resource);
    const preflight = checkDatabaseState(start);
    expect(preflight.errors).toEqual([]);
    expect(checkDatabaseState(start, { ready: true, hmacKey: "ab".repeat(32) }).errors).toEqual([
      expect.stringContaining("journal completo"),
    ]);
    expect(preflight.last).toMatch(new RegExp(`^000${initial}_`));
    expect(preflight.pending).toHaveLength(migrations.length - initial - 1);
    originalJournal = start.journal;
    originalCatalog = start.catalog;
    originalHistory = await history(client, initial);

    if (initial === 5) {
      archive = await backup(resource);
      const failingMigration = {
        ...migrations[7],
        sql: ["insert into app_metadata (key,value) values ('rehearsal','null')"],
      };
      await expect(applyMigrations(resource, [...migrations.slice(0, 7), failingMigration])).rejects.toMatchObject({
        cause: { code: "23505" },
      });
      expect(await readState(resource)).toEqual(start);
      expect(await history(client, initial)).toEqual(originalHistory);
    }
    await applyMigrations(resource);
    const updated = await readState(resource);
    expect(checkDatabaseState(updated, { ready: true, hmacKey: process.env.AUTH_RATE_LIMIT_HMAC_KEY })).toMatchObject({
      pending: [], errors: [],
    });
    expect(updated.catalog).toEqual(cleanCatalog);
    await assertHistoricalState(client, initial, originalHistory);
    await applyMigrations(resource);
    expect(await readState(resource)).toEqual(updated);
    await assertHistoricalState(client, initial, originalHistory);

    await expectConstraint(client, `insert into users (id,email,email_normalized,password_hash,role)
      values ('duplicate','active@example.invalid','active@example.invalid','synthetic','STUDENT')`, "23505");
    await expectConstraint(client, `insert into student_profile_edits (id,student_profile_id,edited_by_user_id,operation,changes)
      values ('orphan','missing','admin','UPDATE_STUDENT_DETAILS','{}')`, "23503");
    await expectConstraint(client, `insert into credit_ledger_movements (id,student_profile_id,movement_type,amount,idempotency_key,manual_request_id)
      values ('orphan','profile','MANUAL_GRANT',1,'orphan','12345678-1234-1234-1234-123456789abc')`, "23503");
    await expectConstraint(client, "update academic_regulations set monthly_recoveries=10 where id='initial'", "55000");
    await verifyNewAuditAndRequest(client);
    await assertHistoricalState(client, initial, originalHistory);

    const independent = await openVerifiedTestConnection(env, ["rehearsal"]);
    try {
      expect(independent.run.containerId).toBe(run.containerId);
      await expect(reserveLoginAttempt(drizzle(client, { schema }), "rehearsal@example.invalid")).resolves.not.toBeNull();
      await expect(reserveLoginAttempt(drizzle(independent.client, { schema }), "rehearsal@example.invalid")).resolves.not.toBeNull();
      expect((await client.query("select attempts from login_attempt_budgets order by key")).rows)
        .toEqual([{ attempts: 2 }, { attempts: 2 }]);
    } finally {
      await independent.client.end();
    }
  });

  if (archive) {
    const verifiedArchive = archive;
    await withRehearsal(async (restored) => {
      const truncated = verifiedArchive.bytes.subarray(0, 12);
      await expect(restore(restored, { ...verifiedArchive, bytes: truncated })).rejects.toThrow("checksum");
      await expect(restore(restored, { bytes: truncated, sha256: digest(truncated) })).rejects.toThrow("Invalid PostgreSQL archive");
      expect((await readState(restored)).journal).toEqual([]);
      await restore(restored, verifiedArchive);
      const recovered = await readState(restored);
      expect(recovered.journal).toEqual(originalJournal);
      expect(recovered.catalog).toEqual(originalCatalog);
      expect(await history(restored.client, initial)).toEqual(originalHistory);
      expect(checkDatabaseState(recovered).errors).toEqual([]);
      await expect(restore(restored, verifiedArchive)).rejects.toThrow("empty rehearsal");
    });
  }
}, 60_000);

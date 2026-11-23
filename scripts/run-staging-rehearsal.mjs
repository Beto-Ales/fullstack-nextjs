import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  checkDatabaseState, expectedJournal, migrationsFolder, readDatabaseState, schemaFingerprint,
} from "./db-inspection.mjs";
import { openVerifiedTestConnection } from "./postgres-test-guard.mjs";
import { withDisposablePostgres } from "./run-postgres-tests.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const nextCli = join(root, "node_modules", "next", "dist", "bin", "next");
const headTag = "0016_habitual_reservation_provenance";
const persistentContainers = ["fullstack_nextjs_postgres_dev", "fullstack_nextjs_postgres_test"];
const seededTables = [
  "app_metadata", "users", "sessions", "student_profiles", "class_templates", "student_template_assignments",
  "class_sessions", "session_capacity_blocks", "class_reservations", "reservation_cancellations",
  "reservation_attendance_records", "credit_ledger_movements",
];
const secrets = [];
const secretLabels = new Map();
const checks = [];

function remember(label, value) {
  if (value) {
    secrets.push(value);
    secretLabels.set(value, label);
  }
  return value;
}

function check(id, condition, detail = "comprobación fallida") {
  if (!condition) throw new Error(`${id}: ${detail}`);
  checks.push(id);
  console.log(`[staging] OK ${id}`);
}

function redact(text) {
  let result = String(text ?? "");
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[redactado]");
  }
  return result;
}

function tail(text, limit = 4000) {
  return redact(text).slice(-limit).trim();
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function docker(args, options = {}) {
  const { stdout } = await exec("docker", args, { timeout: 20_000, windowsHide: true, ...options });
  return stdout.trim();
}

async function persistentState() {
  try {
    return await docker(["inspect", "--type=container", "--format", "{{.Name}} {{.State.StartedAt}} {{.State.Running}}", ...persistentContainers]);
  } catch {
    return null;
  }
}

function inheritedEnvironment() {
  if (process.env.TEST_DATABASE_URL || process.env.POSTGRES_TEST_RUN) {
    throw new Error("El ensayo aprovisiona su propia identidad. Retira TEST_DATABASE_URL y POSTGRES_TEST_RUN.");
  }
  const env = { ...process.env };
  for (const key of ["DATABASE_URL", "DATABASE_INSPECTION_URL", "DB_EXPECTED_NAME", "DB_EXPECTED_SYSTEM_ID",
    "AUTH_RATE_LIMIT_HMAC_KEY", "AUTH_RATE_LIMIT_MAX_ATTEMPTS", "AUTH_RATE_LIMIT_WINDOW_MINUTES", "E2E_PORT", "PORT"]) {
    delete env[key];
  }
  return env;
}

const localSecretKeys = new Set([
  "DATABASE_URL", "DATABASE_INSPECTION_URL", "TEST_DATABASE_URL", "AUTH_RATE_LIMIT_HMAC_KEY",
]);

/** Lee solo las credenciales locales de `.env` para vigilarlas; nunca las imprime ni las escribe. */
function rememberLocalEnvironmentSecrets() {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !localSecretKeys.has(match[1])) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    remember(`credencial local de .env (${match[1]})`, value);
  }
}

function findLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function isLoopbackPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function isLoopbackPortFreeEventually(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isLoopbackPortFree(port)) return true;
    await delay(250);
  }
  return false;
}

function runProcess(label, args, env, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(-60_000); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-60_000); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} excedió ${Math.round(timeout / 1000)} s.\n${tail(stderr) || tail(stdout)}`));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} no pudo arrancar: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} falló (código ${code}).\n${tail(stderr) || tail(stdout)}`));
    });
  });
}

function dockerTool(run, tool, args, input) {
  return execFileSync("docker", ["exec", "-i", run.containerId, tool, ...args], {
    input, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
}

function socketArgs(run) {
  return ["--host=/var/run/postgresql", "--port=5432", "--no-password", `--username=${run.user}`, `--dbname=${run.database}`];
}

function readState(target) {
  return readDatabaseState(target.client, { database: target.run.database, systemId: target.run.systemId });
}

async function tableNames(client) {
  const { rows } = await client.query(`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by c.relname collate "C"
  `);
  return rows.map(({ name }) => name);
}

async function rowCounts(client) {
  const counts = {};
  for (const table of await tableNames(client)) {
    const { rows } = await client.query(`select count(*)::int as total from ${quoteIdent(table)}`);
    counts[table] = rows[0].total;
  }
  return counts;
}

async function tableRows(client, tables = seededTables) {
  const rows = {};
  for (const table of tables) {
    const result = await client.query(
      `select to_jsonb(record) as value from ${quoteIdent(table)} record order by to_jsonb(record)::text`,
    );
    rows[table] = result.rows.map(({ value }) => value);
  }
  return rows;
}

async function readIntegrity(client) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from class_reservations r
        left join student_template_assignments a on a.id = r.habitual_assignment_id
        where r.habitual_assignment_id is not null and a.id is null) as orphan_habitual_links,
      (select count(*)::int from class_reservations
        where id = 'staging-future-reservation' and habitual_assignment_id = 'staging-habitual') as habitual_link,
      (select count(*)::int from class_reservations
        where id = 'staging-cancelled-reservation' and status = 'CANCELLED' and origin = 'ORDINARY') as cancelled_link,
      (select count(*)::int from credit_ledger_movements
        where id = 'staging-consumption' and movement_type = 'RECOVERY_CONSUMPTION'
          and related_reservation_id = 'staging-future-reservation') as consumption_link,
      (select count(*)::int from pg_indexes
        where schemaname = 'public' and indexname = 'class_reservations_habitual_assignment_idx') as habitual_index,
      (select count(*)::int from pg_constraint
        where conname = 'class_reservations_habitual_assignment_id_student_template_assignments_id_fk'
          and conrelid = 'public.class_reservations'::regclass) as habitual_foreign_key
  `);
  return rows[0];
}

function assertIntegrity(target, label) {
  const expected = {
    orphan_habitual_links: 0, habitual_link: 1, cancelled_link: 1, consumption_link: 1,
    habitual_index: 1, habitual_foreign_key: 1,
  };
  for (const [key, value] of Object.entries(expected)) {
    check(`${label}-${key}`, target[key] === value, `se esperaba ${value} y se obtuvo ${target[key]}`);
  }
}

function sessionTokenPair(id, userId) {
  const token = remember(`token de sesión ${id}`, randomBytes(32).toString("base64url"));
  return { id, userId, token, tokenHash: createHash("sha256").update(token).digest("hex") };
}

const seedSql = `
  insert into app_metadata (key, value) values ('staging-rehearsal', '{"synthetic":true}'::jsonb);
  insert into users (id, email, email_normalized, password_hash, role, status) values
    ('staging-admin', 'staging-admin@example.invalid', 'staging-admin@example.invalid',
      'synthetic-not-a-password-hash', 'SUPER_ADMIN', 'ACTIVE'),
    ('staging-student', 'staging-student@example.invalid', 'staging-student@example.invalid',
      'synthetic-not-a-password-hash', 'STUDENT', 'ACTIVE');
  insert into student_profiles (id, user_id, first_name, last_name, contact_email) values
    ('staging-profile', 'staging-student', 'Synthetic', 'Staging', 'staging-student@example.invalid');
  insert into class_templates (id, name, iso_weekday, starts_at_local_time, duration_minutes, effective_from,
    category, max_capacity, regulation_version_id) values
    ('staging-template', 'Synthetic staging class',
      extract(isodow from (now() at time zone 'Europe/Copenhagen')::date + 3)::int,
      '18:00', 60, '2026-01-01', 'Synthetic', 12, 'initial');
  insert into student_template_assignments (id, student_profile_id, template_id, effective_from, status)
    values ('staging-habitual', 'staging-profile', 'staging-template', '2026-01-01', 'ACTIVE');
  insert into class_sessions (id, template_id, local_date, starts_at_utc, ends_at_utc, status, max_capacity,
    regulation_version_id) values
    ('staging-completed-session', 'staging-template',
      (now() at time zone 'Europe/Copenhagen')::date - 1,
      ((now() at time zone 'Europe/Copenhagen')::date - 1 + time '18:00') at time zone 'Europe/Copenhagen',
      ((now() at time zone 'Europe/Copenhagen')::date - 1 + time '19:00') at time zone 'Europe/Copenhagen',
      'COMPLETED', 12, 'initial'),
    ('staging-future-session', 'staging-template',
      (now() at time zone 'Europe/Copenhagen')::date + 3,
      ((now() at time zone 'Europe/Copenhagen')::date + 3 + time '18:00') at time zone 'Europe/Copenhagen',
      ((now() at time zone 'Europe/Copenhagen')::date + 3 + time '19:00') at time zone 'Europe/Copenhagen',
      'SCHEDULED', 12, 'initial');
  insert into session_capacity_blocks (id, class_session_id, blocked_spots, reason, blocked_by_user_id,
    regulation_version_id) values
    ('staging-block', 'staging-future-session', 1, 'Synthetic block', 'staging-admin', 'initial');
  insert into class_reservations (id, class_session_id, student_profile_id, status, origin, habitual_assignment_id,
    cancelled_at, cancelled_by_user_id, regulation_version_id, created_by_user_id) values
    ('staging-cancelled-reservation', 'staging-completed-session', 'staging-profile', 'CANCELLED', 'ORDINARY',
      'staging-habitual', now() - interval '2 days', 'staging-admin', 'initial', 'staging-admin'),
    ('staging-attended-reservation', 'staging-completed-session', 'staging-profile', 'CONFIRMED', 'ORDINARY',
      'staging-habitual', null, null, 'initial', 'staging-admin'),
    ('staging-future-reservation', 'staging-future-session', 'staging-profile', 'CONFIRMED', 'MAKEUP',
      'staging-habitual', null, null, 'initial', 'staging-admin');
  insert into reservation_cancellations (id, reservation_id, student_profile_id, class_session_id,
    cancelled_by_user_id, cancelled_at, decision_source, regulation_version_id, cancellation_type,
    hours_before_start, meets_seven_day_rule, is_habitual_reservation, sequence_id, sequence_position,
    is_third_cancellation, can_generate_credit_candidate, credit_resolution) values
    ('staging-cancellation', 'staging-cancelled-reservation', 'staging-profile', 'staging-completed-session',
      'staging-student', now() - interval '2 days', 'STUDENT_REQUEST', 'initial', 'ON_TIME', 300, true, true,
      'staging-sequence', 3, true, true, 'GRANTED');
  insert into reservation_attendance_records (id, reservation_id, student_profile_id, class_session_id, outcome,
    source, recorded_by_user_id, recorded_at, regulation_version_id) values
    ('staging-attendance', 'staging-attended-reservation', 'staging-profile', 'staging-completed-session',
      'ATTENDED', 'MANUAL', 'staging-admin', now() - interval '1 day', 'initial');
  insert into credit_ledger_movements (id, student_profile_id, movement_type, amount, expires_at, class_session_id,
    related_reservation_id, admin_user_id, source_cancellation_id, source_movement_id, source_grant_movement_id,
    idempotency_key, regulation_version_id) values
    ('staging-grant', 'staging-profile', 'AUTO_CANCELLATION_GRANT', 1, now() + interval '6 months',
      'staging-completed-session', null, null, 'staging-cancellation', null, null, 'staging-grant', 'initial'),
    ('staging-consumption', 'staging-profile', 'RECOVERY_CONSUMPTION', -1, null, 'staging-future-session',
      'staging-future-reservation', null, null, 'staging-grant', 'staging-grant', 'staging-consumption', 'initial'),
    ('staging-manual', 'staging-profile', 'MANUAL_GRANT', 2, now() + interval '6 months', null, null,
      'staging-admin', null, null, null, 'staging-manual', 'initial');
`;

async function seed(client) {
  await client.query(seedSql);
  const admin = sessionTokenPair("staging-admin-session", "staging-admin");
  const student = sessionTokenPair("staging-student-session", "staging-student");
  await client.query(
    `insert into sessions (id, user_id, token_hash, expires_at, user_agent) values
      ($1, $2, $3, now() + interval '2 hours', 'staging-rehearsal'),
      ($4, $5, $6, now() + interval '2 hours', 'staging-rehearsal')`,
    [admin.id, admin.userId, admin.tokenHash, student.id, student.userId, student.tokenHash],
  );
  return { admin, student };
}

function walkFiles(directory) {
  const files = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function scanFiles(directory, patterns) {
  const matches = [];
  if (!existsSync(directory)) return matches;
  for (const file of walkFiles(directory)) {
    const { size } = statSync(file);
    if (size === 0 || size > 32 * 1024 * 1024) continue;
    const content = readFileSync(file, "latin1");
    if (patterns.some((pattern) => content.includes(pattern))) matches.push(file);
  }
  return matches;
}

function scanSecrets(directory) {
  const matches = [];
  for (const [secret, label] of secretLabels) {
    for (const file of scanFiles(directory, [secret])) matches.push(`${label} en ${file}`);
  }
  return matches;
}

function scanStaticForDatabaseUrls() {
  const directory = join(root, ".next", "static");
  const matches = [];
  if (!existsSync(directory)) return matches;
  const pattern = /postgres(?:ql)?:\/\/[^\s"'<>\\]+/;
  for (const file of walkFiles(directory)) {
    const { size } = statSync(file);
    if (size === 0 || size > 32 * 1024 * 1024) continue;
    const content = readFileSync(file, "latin1");
    const match = content.match(pattern);
    if (match) matches.push(`${file}: ${match[0]}`);
  }
  return matches;
}
function nextRuntimeEnvironment(appEnv) {
  return {
    ...appEnv,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
  };
}

const buildDatabaseUrl = "postgresql://staging_build:staging_build@127.0.0.1:1/staging_build";
const buildRateLimitKey = "0".repeat(64);

/** La compilación nunca recibe credenciales reales: usa valores inertes y una base inalcanzable. */
function buildEnvironment() {
  const env = inheritedEnvironment();
  return {
    ...env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    // `next build` carga `.env`; estos valores vacíos impiden que inyecte identidades persistentes.
    TEST_DATABASE_URL: "",
    POSTGRES_TEST_RUN: "",
    DATABASE_INSPECTION_URL: "",
    DATABASE_URL: buildDatabaseUrl,
    AUTH_RATE_LIMIT_HMAC_KEY: buildRateLimitKey,
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: "5",
    AUTH_RATE_LIMIT_WINDOW_MINUTES: "15",
    APP_TIME_ZONE: "Europe/Copenhagen",
    LOG_LEVEL: "info",
  };
}

async function buildApplication() {
  check("next-cli-present", existsSync(nextCli), `no se encontró ${nextCli}; ejecuta npm install`);
  check(
    "build-environment-is-synthetic",
    !secretLabels.has(buildDatabaseUrl) && !secretLabels.has(buildRateLimitKey),
    "el entorno de compilación reutiliza un secreto del ensayo",
  );
  rmSync(join(root, ".next"), { recursive: true, force: true });
  const { stdout } = await runProcess("next build", [nextCli, "build"], buildEnvironment(), 15 * 60_000);
  const summary = stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(-10);
  console.log(summary.map((line) => `[staging]   ${line}`).join("\n"));
  check("build-id", existsSync(join(root, ".next", "BUILD_ID")), "next build no generó .next/BUILD_ID");
  check("build-server-output", existsSync(join(root, ".next", "server", "app")), "next build no generó .next/server/app");
  // La caché incremental de Turbopack no forma parte del artefacto y puede retener valores del entorno.
  rmSync(join(root, ".next", "cache"), { recursive: true, force: true });
  check("build-cache-absent", !existsSync(join(root, ".next", "cache")), "la caché de compilación sigue presente");
  const leaked = scanSecrets(join(root, ".next"));
  check("build-no-known-secrets", leaked.length === 0, `credenciales conocidas presentes en: ${leaked.join(", ")}`);
  const databaseUrls = scanStaticForDatabaseUrls();
  check("build-client-bundle-clean", databaseUrls.length === 0, `URLs de base de datos en el bundle cliente: ${databaseUrls.join(", ")}`);
}

function startNext(appEnv, port) {
  const child = spawn(
    process.execPath,
    [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: root, env: nextRuntimeEnvironment(appEnv), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let log = "";
  const append = (chunk) => { log = (log + chunk).slice(-20_000); };
  child.stdout.setEncoding("utf8").on("data", append);
  child.stderr.setEncoding("utf8").on("data", append);
  child.once("error", (error) => { log += `\n[spawn] ${error.message}`; });
  return { child, log: () => log };
}

async function waitForApplication(server, port) {
  const deadline = Date.now() + 120_000;
  const url = `http://127.0.0.1:${port}/login`;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`next start terminó con código ${server.child.exitCode} antes de responder.\n${tail(server.log())}`);
    }
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      await response.text();
      if (response.status === 200) return;
    } catch {
      // El servidor todavía no escucha en el puerto reservado.
    }
    await delay(500);
  }
  throw new Error(`next start no respondió en 120 s.\n${tail(server.log())}`);
}

async function stopNext(server) {
  const { child } = server;
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "close"), delay(10_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "close"), delay(5_000)]);
  }
}

async function httpRequest(server, port, path, cookie) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, location: response.headers.get("location"), body: await response.text() };
  } catch (error) {
    throw new Error(`Fallo al solicitar ${path}.\n${tail(server.log())}\n${redact(error.message)}`);
  }
}

function expectRedirect(id, response, target, server) {
  const location = response.location ?? "";
  const path = location.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
  check(
    id,
    response.status >= 300 && response.status < 400 && path === target,
    `se esperaba redirección a ${target}; se obtuvo ${response.status} ${location || "sin Location"}\n${tail(server.log())}`,
  );
}

function expectPage(id, response, text, server) {
  check(
    id,
    response.status === 200 && response.body.includes(text),
    `se esperaba HTTP 200 con "${text}"; se obtuvo ${response.status}\n${tail(server.log())}`,
  );
}
function verifyClientTools(run) {
  const dump = dockerTool(run, "pg_dump", ["--version"]).toString().trim();
  const restore = dockerTool(run, "pg_restore", ["--version"]).toString().trim();
  check(
    "client-tools-version",
    /^pg_dump \(PostgreSQL\) 15\./.test(dump) && /^pg_restore \(PostgreSQL\) 15\./.test(restore),
    `${dump} / ${restore}`,
  );
}

async function verifyRestore(inheritedEnv, backup, expected, hmacKey) {
  await withDisposablePostgres("staging", async (env) => {
    const target = await openVerifiedTestConnection(env, ["staging"]);
    try {
      verifyClientTools(target.run);
      const empty = await readState(target);
      check(
        "restore-target-empty",
        !empty.identity.journalExists && empty.journal.length === 0
          && JSON.stringify(empty.catalog) === JSON.stringify([["schema", "public", ""]]),
        "el destino de restauración no está vacío",
      );
      dockerTool(
        target.run,
        "pg_restore",
        ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", ...socketArgs(target.run)],
        backup,
      );
      const restored = await readState(target);
      check("restore-journal", JSON.stringify(restored.journal) === JSON.stringify(expected.journal),
        "el journal restaurado difiere del original");
      check("restore-catalog", JSON.stringify(restored.catalog) === JSON.stringify(expected.catalog),
        "el catálogo restaurado difiere del original");
      check("restore-schema-fingerprint", schemaFingerprint(restored.catalog) === expected.catalogHash,
        "la huella del esquema restaurado difiere de la de referencia");
      const counts = await rowCounts(target.client);
      check("restore-row-counts", JSON.stringify(counts) === JSON.stringify(expected.counts),
        `recuento distinto: ${JSON.stringify(counts)}`);
      const rows = await tableRows(target.client);
      check("restore-row-data", JSON.stringify(rows) === JSON.stringify(expected.rows),
        "los datos restaurados difieren del origen");
      assertIntegrity(await readIntegrity(target.client), "restore-integrity");
      const ready = checkDatabaseState(restored, { ready: true, hmacKey, maxAttempts: "5", windowMinutes: "15" });
      check("restore-ready", ready.errors.length === 0 && ready.last === headTag, JSON.stringify(ready.errors));
    } finally {
      await target.client.end();
    }
  }, inheritedEnv);
}
async function rehearse(inheritedEnv, backupFile, hmacKey) {
  return withDisposablePostgres("staging", async (env, { runId }) => {
    const target = await openVerifiedTestConnection(env, ["staging"]);
    remember("cadena de conexión desechable", target.run.connectionString);
    remember("contraseña desechable", new URL(target.run.connectionString).password);
    try {
      verifyClientTools(target.run);

      const empty = await readState(target);
      check(
        "fresh-database",
        !empty.identity.journalExists && empty.journal.length === 0
          && JSON.stringify(empty.catalog) === JSON.stringify([["schema", "public", ""]]),
        "la base desechable no está vacía antes de migrar",
      );

      const migrations = readMigrationFiles({ migrationsFolder });
      const expected = expectedJournal();
      check(
        "migration-source",
        migrations.length === expected.length,
        `el repositorio aporta ${migrations.length} migraciones y el journal ${expected.length}`,
      );
      const dialect = new PgDialect();
      const session = drizzle(target.client)._.session;
      await dialect.migrate(migrations.slice(0, 5), session, { migrationsFolder });
      const historical = checkDatabaseState(await readState(target), { ready: false });
      check(
        "historical-prefix",
        historical.last === expected[4].tag && historical.errors.length === 0
          && historical.pending.length === expected.length - 5,
        `el prefijo de 5 migraciones no es válido: última=${historical.last ?? "ninguna"} ${JSON.stringify(historical.errors)}`,
      );
      await dialect.migrate(migrations, session, { migrationsFolder });
      const migrated = await readState(target);
      const head = checkDatabaseState(migrated, { ready: true, hmacKey, maxAttempts: "5", windowMinutes: "15" });
      check("migration-head", head.last === headTag, `última migración aplicada: ${head.last ?? "ninguna"}`);
      check(
        "migration-complete",
        migrated.journal.length === expected.length && head.pending.length === 0 && head.errors.length === 0,
        `migraciones=${migrated.journal.length}/${expected.length} ${JSON.stringify(head.errors)}`,
      );
      check(
        "migration-catalog",
        head.catalogHash === schemaFingerprint(migrated.catalog),
        `huella ${head.catalogHash.slice(0, 12)}… distinta de la de referencia`,
      );
      const missingConfig = checkDatabaseState(migrated, { ready: true });
      check(
        "config-fails-closed",
        missingConfig.errors.length === 1 && missingConfig.errors[0].includes("AUTH_RATE_LIMIT_HMAC_KEY"),
        JSON.stringify(missingConfig.errors),
      );
      const invalidConfig = checkDatabaseState(migrated, {
        ready: true, hmacKey, maxAttempts: "0", windowMinutes: "61",
      });
      check("config-validates-limits", invalidConfig.errors.length === 2, JSON.stringify(invalidConfig.errors));

      const tokens = await seed(target.client);
      const counts = await rowCounts(target.client);
      check("seed-populated", seededTables.every((table) => counts[table] > 0), JSON.stringify(counts));
      check("seed-sessions", counts.sessions === 2, `sessions=${counts.sessions}`);
      assertIntegrity(await readIntegrity(target.client), "database-integrity");

      const backup = dockerTool(
        target.run,
        "pg_dump",
        ["--format=custom", "--exclude-schema=test_provisioning", ...socketArgs(target.run)],
      );
      writeFileSync(backupFile, backup);
      const persisted = readFileSync(backupFile);
      check(
        "backup-persisted",
        backup.length > 0 && persisted.length === backup.length && digest(persisted) === digest(backup),
        "el archivo de respaldo no se conservó íntegro",
      );
      const toc = dockerTool(target.run, "pg_restore", ["--list"], persisted).toString().split(/\r?\n/);
      check(
        "backup-content",
        ["public users", "public class_reservations", "public credit_ledger_movements"]
          .every((table) => toc.some((line) => line.includes(` TABLE ${table} `) || line.includes(` TABLE DATA ${table} `)))
          && toc.some((line) => line.includes(" TABLE DATA drizzle __drizzle_migrations ")),
        "el respaldo omite tablas o el journal esperados",
      );
      check(
        "backup-excludes-provisioning",
        !toc.some((line) => line.includes("test_provisioning")),
        "el respaldo contiene el esquema de aprovisionamiento",
      );

      await verifyRestore(inheritedEnv, persisted, {
        journal: migrated.journal,
        catalog: migrated.catalog,
        catalogHash: head.catalogHash,
        counts,
        rows: await tableRows(target.client),
      }, hmacKey);

      const appEnv = { ...env };
      Object.assign(appEnv, {
        NODE_ENV: "production",
        DATABASE_URL: target.run.connectionString,
        APP_TIME_ZONE: "Europe/Copenhagen",
        LOG_LEVEL: "info",
        AUTH_RATE_LIMIT_HMAC_KEY: hmacKey,
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: "5",
        AUTH_RATE_LIMIT_WINDOW_MINUTES: "15",
        // Next carga `.env`: estos valores vacíos tapan la identidad persistente del archivo local.
        TEST_DATABASE_URL: "",
        POSTGRES_TEST_RUN: "",
        DATABASE_INSPECTION_URL: "",
      });
      const appUrl = new URL(appEnv.DATABASE_URL);
      check(
        "application-uses-disposable-database",
        appUrl.hostname === "127.0.0.1" && appUrl.port === String(target.run.port)
          && !["5432", "5433"].includes(appUrl.port)
          && decodeURIComponent(appUrl.pathname.slice(1)) === target.run.database,
        "DATABASE_URL de la aplicación no apunta al PostgreSQL desechable",
      );
      check(
        "application-has-no-test-identity",
        !appEnv.TEST_DATABASE_URL && !appEnv.POSTGRES_TEST_RUN && !appEnv.DATABASE_INSPECTION_URL,
        "el proceso de aplicación recibió identidad de pruebas",
      );

      const beforeBuild = await readState(target);
      await buildApplication();

      const port = await findLoopbackPort();
      const server = startNext(appEnv, port);
      try {
        await waitForApplication(server, port);
        const adminCookie = `__Host-artwork_session=${tokens.admin.token}`;
        const studentCookie = `__Host-artwork_session=${tokens.student.token}`;
        expectPage("smoke-home", await httpRequest(server, port, "/"), "notes app", server);
        const login = await httpRequest(server, port, "/login");
        expectPage("smoke-login", login, "Iniciar sesión", server);
        check("smoke-login-form", login.body.includes("<form"), "el formulario de acceso no se renderizó");
        expectRedirect("smoke-admin-anonymous", await httpRequest(server, port, "/admin"), "/login", server);
        expectRedirect("smoke-student-anonymous", await httpRequest(server, port, "/student"), "/login", server);
        expectRedirect("smoke-regulation-anonymous", await httpRequest(server, port, "/normativa"), "/login", server);
        expectPage("smoke-admin-session", await httpRequest(server, port, "/admin", adminCookie),
          "Área de administración", server);
        expectRedirect("smoke-admin-login", await httpRequest(server, port, "/login", adminCookie), "/admin", server);
        expectRedirect("smoke-admin-student", await httpRequest(server, port, "/student", adminCookie), "/admin", server);
        expectPage("smoke-admin-regulation", await httpRequest(server, port, "/normativa", adminCookie),
          "Normativa de clases y recuperaciones", server);
        expectPage("smoke-student-session", await httpRequest(server, port, "/student", studentCookie),
          "Área de alumno", server);
        expectRedirect("smoke-student-login", await httpRequest(server, port, "/login", studentCookie), "/student", server);
        expectRedirect("smoke-student-admin", await httpRequest(server, port, "/admin", studentCookie), "/student", server);
        expectPage("smoke-student-regulation", await httpRequest(server, port, "/normativa", studentCookie),
          "Normativa de clases y recuperaciones", server);
        expectRedirect("smoke-invalid-session",
          await httpRequest(server, port, "/admin", "__Host-artwork_session=invalid"), "/login", server);

        const afterRequests = await readState(target);
        check(
          "smoke-read-only-schema",
          JSON.stringify(afterRequests.catalog) === JSON.stringify(beforeBuild.catalog)
            && JSON.stringify(afterRequests.journal) === JSON.stringify(beforeBuild.journal),
          "las peticiones HTTP modificaron el esquema o el journal",
        );
        check(
          "smoke-read-only-data",
          JSON.stringify(await rowCounts(target.client)) === JSON.stringify(counts),
          "las peticiones HTTP escribieron datos",
        );
        check(
          "smoke-still-at-head",
          afterRequests.journal.length === expected.length && schemaFingerprint(afterRequests.catalog) === head.catalogHash,
          "el esquema dejó de coincidir con 0016 tras el arranque",
        );
      } finally {
        await stopNext(server);
      }
      check("application-stopped", await isLoopbackPortFreeEventually(port), `el puerto ${port} sigue ocupado`);

      return { runId, port, schemaHash: head.catalogHash, backupHash: digest(persisted) };

    } finally {
      await target.client.end();
    }
  }, inheritedEnv);
}
async function containerGone(runId) {
  const name = `fullstack-nextjs-test-${runId}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const names = await docker(["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"]);
      if (!names.split(/\r?\n/).includes(name)) return true;
    } catch {
      return false;
    }
    await delay(250);
  }
  return false;
}

async function main() {
  const inheritedEnv = inheritedEnvironment();
  check(
    "environment-isolated",
    !inheritedEnv.DATABASE_URL && !inheritedEnv.TEST_DATABASE_URL && !inheritedEnv.POSTGRES_TEST_RUN
      && !inheritedEnv.DATABASE_INSPECTION_URL,
    "el ensayo heredó una identidad de base de datos persistente",
  );

  // Secrets live only in this process and in the disposable child processes.
  rememberLocalEnvironmentSecrets();
  const hmacKey = remember("clave HMAC sintética", randomBytes(32).toString("hex"));
  const persistentBefore = await persistentState();
  const backupDir = mkdtempSync(join(tmpdir(), "artworkshop-staging-"));
  const backupFile = join(backupDir, "staging-synthetic.dump");
  let result;
  try {
    result = await rehearse(inheritedEnv, backupFile, hmacKey);
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
  if (!result || typeof result !== "object") {
    process.exitCode = Number(result ?? 1) || 1;
    return;
  }

  check("backup-temporary-removed", !existsSync(backupDir), "el respaldo temporal no se eliminó");
  check("disposable-container-removed", await containerGone(result.runId),
    `el contenedor fullstack-nextjs-test-${result.runId} sigue presente`);
  check("persistent-services-untouched", persistentBefore === (await persistentState()),
    "los servicios persistentes DEV/TEST cambiaron de estado durante el ensayo");

  console.log(
    `[staging] Ensayo completado: ${checks.length} comprobaciones, journal ${headTag}, `
    + `esquema ${result.schemaHash.slice(0, 12)}…, respaldo ${result.backupHash.slice(0, 12)}…, `
    + `aplicación servida en 127.0.0.1:${result.port}.`,
  );
}

main().then(
  () => { process.exitCode ??= 0; },
  (error) => {
    console.error(`[staging] ERROR ${redact(error?.message ?? error)}`);
    process.exitCode = 1;
  },
);

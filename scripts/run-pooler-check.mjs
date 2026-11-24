import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client } from "pg";

import { checkDatabaseState, expectedJournal, readDatabaseState } from "./db-inspection.mjs";
import { migrateTestDatabase, readTestRun, TEST_OWNER_LABEL } from "./postgres-test-guard.mjs";
import { withDisposablePostgres } from "./run-postgres-tests.mjs";

const exec = promisify(execFile);
const POOLER_IMAGE = "edoburu/pgbouncer:latest";
const POOLER_POOL_SIZE = 5;
const HEAD_TAG = "0016_habitual_reservation_provenance";
const PERSISTENT_CONTAINERS = ["fullstack_nextjs_postgres_dev", "fullstack_nextjs_postgres_test"];
const ABSENCE_LOCK = 903000042;
const HABITUAL_LOCK = 903000044;
const SESSION_LOCK_PROBE = 903000099;
const CONCURRENT_TRANSACTIONS = 20;
const SYNTHETIC_HMAC = "0".repeat(64);
const checks = [];
const observations = [];

async function docker(args, options = {}) {
  const { stdout } = await exec("docker", args, { timeout: 30_000, windowsHide: true, ...options });
  return stdout.trim();
}

function check(id, condition, detail) {
  if (!condition) throw new Error(`${id}: ${detail}`);
  checks.push(id);
  console.log(`[pooler] OK ${id}`);
}

function observe(label, value) {
  observations.push(`${label}=${value}`);
  console.log(`[pooler] INFO ${label}=${value}`);
}

function findLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(String(port)));
    });
  });
}

async function persistentState() {
  try {
    return await docker(["inspect", "--type=container", "--format", "{{.Name}} {{.State.StartedAt}} {{.State.Running}}",
      ...PERSISTENT_CONTAINERS]);
  } catch {
    return null;
  }
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "sin-código";
}

async function openClient(connectionString) {
  const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 5_000 });
  await client.connect();
  return client;
}

async function closeClients(clients) {
  for (const client of clients) {
    await client.end().catch(() => {});
  }
}

async function waitForPooler(connectionString, checkInterrupted) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    checkInterrupted();
    const client = new Client({ connectionString, ssl: false, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await delay(400);
    }
  }
  throw new Error("pooler.unavailable: el agrupador no aceptó conexiones a tiempo.");
}

async function assertPoolerOwnership(name, runId) {
  const raw = await docker(["inspect", "--type=container", "--format", "{{json .Config.Labels}}", name]);
  const labels = JSON.parse(raw);
  if (labels?.[TEST_OWNER_LABEL] !== runId || labels?.[`${TEST_OWNER_LABEL}.pooler`] !== runId) {
    throw new Error("El contenedor del agrupador no pertenece a esta ejecución.");
  }
}

async function startPooler(run, password) {
  const name = `fullstack-nextjs-pooler-${run.runId}`;
  const port = await findLoopbackPort();
  await docker(["run", "--detach", "--rm", "--pull", "never", "--name", name,
    "--label", `${TEST_OWNER_LABEL}=${run.runId}`,
    "--label", `${TEST_OWNER_LABEL}.pooler=${run.runId}`,
    "--add-host", "host.docker.internal:host-gateway",
    "--publish", `127.0.0.1:${port}:5432`,
    "--env", "DB_HOST=host.docker.internal",
    "--env", `DB_PORT=${run.port}`,
    "--env", `DB_USER=${run.user}`,
    "--env", `DB_PASSWORD=${password}`,
    "--env", `DB_NAME=${run.database}`,
    "--env", "POOL_MODE=transaction",
    "--env", "AUTH_TYPE=scram-sha-256",
    "--env", `MAX_CLIENT_CONN=${POOLER_POOL_SIZE * 10}`,
    "--env", `DEFAULT_POOL_SIZE=${POOLER_POOL_SIZE}`,
    "--env", "SERVER_RESET_QUERY=DISCARD ALL",
    POOLER_IMAGE]);
  await assertPoolerOwnership(name, run.runId);
  return { name, port, url: `postgresql://${run.user}:${password}@127.0.0.1:${port}/${run.database}` };
}

async function stopPooler(pooler, runId) {
  if (!pooler) return;
  const ownership = await assertPoolerOwnership(pooler.name, runId).then(() => true, () => false);
  if (!ownership) throw new Error("No se pudo confirmar la propiedad del contenedor del agrupador.");
  await docker(["rm", "--force", pooler.name]);
  console.log("[pooler] Agrupador desechable retirado.");
}

async function logPoolMode(name) {
  const logs = await docker(["logs", name]);
  const match = /pool_mode\s*=\s*(\w+)/.exec(logs);
  return match?.[1] ?? "desconocido";
}

async function verifyIdentityThroughPooler(poolerUrl, run) {
  const client = await openClient(poolerUrl);
  try {
    const { rows } = await client.query(`select current_database() as database, current_user as username,
      inet_server_port() as port, current_setting('transaction_read_only') as read_only`);
    check("pooler.identity", rows[0].database === run.database && rows[0].username === run.user
      && rows[0].port === 5432 && rows[0].read_only === "off", "la identidad detrás del agrupador no coincide.");
    return rows[0];
  } finally {
    await client.end();
  }
}

async function verifySchema(directState, poolerUrl, run) {
  const options = { ready: true, hmacKey: SYNTHETIC_HMAC, maxAttempts: "5", windowMinutes: "15" };
  const directResult = checkDatabaseState(directState, options);
  check("schema.direct",
    directResult.errors.length === 0 && directResult.last === HEAD_TAG && directResult.pending.length === 0,
    `journal directo inesperado (${directResult.last ?? "sin journal"}).`);
  observe("schema.direct.hash", directResult.catalogHash);

  const client = await openClient(poolerUrl);
  let pooledResult;
  try {
    const pooledState = await readDatabaseState(client, { database: run.database, systemId: run.systemId });
    pooledResult = checkDatabaseState(pooledState, options);
  } finally {
    await client.end();
  }
  check("schema.via.pooler",
    pooledResult.errors.length === 0 && pooledResult.last === HEAD_TAG && pooledResult.pending.length === 0,
    `catálogo inesperado a través del agrupador (${pooledResult.errors[0] ?? "sin journal"}).`);
  check("schema.pooler.matches.direct", pooledResult.catalogHash === directResult.catalogHash,
    "el catálogo leído a través del agrupador difiere del obtenido por conexión directa.");
}

async function prepareScratch(poolerUrl) {
  const client = await openClient(poolerUrl);
  try {
    await client.query("begin");
    await client.query(`create table pooler_check_parent (id text primary key, note text not null default 'synthetic')`);
    await client.query(`create table pooler_check_child (id text primary key,
      parent_id text not null references pooler_check_parent(id))`);
    await client.query("create table pooler_check_counter (id int primary key, value int not null)");
    await client.query("insert into pooler_check_counter (id, value) values (1, 0)");
    await client.query("create table pooler_check_keys (key text primary key)");
    await client.query("commit");
  } finally {
    await client.end();
  }
  check("ddl.via.pooler", true);
}

async function verifyAdvisoryLock(poolerUrl) {
  const holder = await openClient(poolerUrl);
  const contender = await openClient(poolerUrl);
  try {
    const holderPid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock($1)", [ABSENCE_LOCK]);
    const contenderPid = (await contender.query("select pg_backend_pid() as pid")).rows[0].pid;
    await contender.query("begin");
    const blocked = await contender.query("select pg_try_advisory_xact_lock($1) as acquired", [ABSENCE_LOCK]);
    check("advisory.xact.serialized", blocked.rows[0].acquired === false && holderPid !== contenderPid,
      "el bloqueo asesor global no serializó dos transacciones independientes.");
    await holder.query("commit");
    const acquired = await contender.query("select pg_try_advisory_xact_lock($1) as acquired", [ABSENCE_LOCK]);
    check("advisory.xact.released", acquired.rows[0].acquired === true,
      "el bloqueo asesor de transacción no se liberó al confirmar.");
    await contender.query("commit");
  } finally {
    await closeClients([holder, contender]);
  }
}

async function verifyRowLock(poolerUrl) {
  const setup = await openClient(poolerUrl);
  await setup.query("insert into pooler_check_parent (id) values ('row-1') on conflict do nothing");
  await setup.end();

  const holder = await openClient(poolerUrl);
  const contender = await openClient(poolerUrl);
  try {
    await holder.query("begin");
    await holder.query("select id from pooler_check_parent where id = 'row-1' for update nowait");
    await contender.query("begin");
    let blockedCode = null;
    try {
      await contender.query("select id from pooler_check_parent where id = 'row-1' for update nowait");
    } catch (error) {
      blockedCode = errorCode(error);
    }
    check("rowlock.for.update.blocks", blockedCode === "55P03",
      `la segunda transacción no encontró el bloqueo de fila (${blockedCode ?? "sin error"}).`);
    await contender.query("rollback");
    await holder.query("commit");
    await contender.query("begin");
    const after = await contender.query("select id from pooler_check_parent where id = 'row-1' for update nowait");
    check("rowlock.released.after.commit", after.rowCount === 1, "el bloqueo de fila no se liberó al confirmar.");
    await contender.query("commit");
  } finally {
    await closeClients([holder, contender]);
  }
}

async function verifyAtomicityAndForeignKeys(poolerUrl) {
  const client = await openClient(poolerUrl);
  try {
    await client.query("begin");
    await client.query("insert into pooler_check_parent (id) values ('rollback-row')");
    await client.query("rollback");
    const rolledBack = await client.query("select count(*)::int as total from pooler_check_parent where id = 'rollback-row'");
    check("rollback.discards.writes", rolledBack.rows[0].total === 0, "una escritura revertida persistió.");

    await client.query("begin");
    await client.query("insert into pooler_check_parent (id) values ('committed-row')");
    await client.query("commit");
    const committed = await client.query("select count(*)::int as total from pooler_check_parent where id = 'committed-row'");
    check("commit.persists.writes", committed.rows[0].total === 1, "una escritura confirmada no persistió.");

    await client.query("begin");
    let fkCode = null;
    try {
      await client.query("insert into pooler_check_child (id, parent_id) values ('child-1', 'missing-parent')");
    } catch (error) {
      fkCode = errorCode(error);
    }
    check("fk.enforced", fkCode === "23503", `la clave foránea no rechazó la fila huérfana (${fkCode ?? "sin error"}).`);
    await client.query("rollback");
    const orphan = await client.query("select count(*)::int as total from pooler_check_child");
    check("fk.no.partial.writes", orphan.rows[0].total === 0,
      "quedaron escrituras parciales tras el fallo de clave foránea.");
  } finally {
    await client.end();
  }
}

async function verifyStatementTimeout(poolerUrl) {
  const client = await openClient(poolerUrl);
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '250ms'");
    let timeoutCode = null;
    try {
      await client.query("select pg_sleep(1)");
    } catch (error) {
      timeoutCode = errorCode(error);
    }
    check("setlocal.timeout.enforced", timeoutCode === "57014",
      `SET LOCAL statement_timeout no interrumpió la consulta (${timeoutCode ?? "sin error"}).`);
    await client.query("rollback");

    await client.query("begin");
    const { rows } = await client.query("show statement_timeout");
    await client.query("commit");
    check("setlocal.timeout.not.leaked", rows[0].statement_timeout === "0",
      `el límite de sentencia sobrevivió a la transacción (${rows[0].statement_timeout}).`);
    observe("setlocal.timeout.after.transaction", rows[0].statement_timeout);
  } finally {
    await client.end();
  }
}

async function verifyUnnamedStatements(poolerUrl) {
  const client = await openClient(poolerUrl);
  try {
    for (let index = 0; index < 100; index += 1) {
      const { rows } = await client.query("select $1::int * 2 as doubled, $2::text as label", [index, `s${index}`]);
      if (rows[0].doubled !== index * 2 || rows[0].label !== `s${index}`) {
        throw new Error("unnamed.statements: una consulta parametrizada devolvió un resultado inesperado.");
      }
    }
    check("unnamed.statements", true);
  } finally {
    await client.end();
  }
}

async function verifyConcurrency(poolerUrl) {
  const clients = await Promise.all(
    Array.from({ length: CONCURRENT_TRANSACTIONS }, () => openClient(poolerUrl)));
  let failures = 0;
  let inserted = 0;
  try {
    const results = await Promise.allSettled(clients.map(async (client) => {
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock($1, hashtext($2))", [HABITUAL_LOCK, "pooler-check"]);
        await delay(10);
        await client.query("update pooler_check_counter set value = value + 1 where id = 1");
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }));
    failures = results.filter((result) => result.status === "rejected").length;

    const insertResults = await Promise.allSettled(clients.map((client) =>
      client.query("insert into pooler_check_keys (key) values ('shared') on conflict do nothing")));
    inserted = insertResults.reduce((total, result) => total + (result.status === "fulfilled" ? result.value.rowCount : 0), 0);
  } finally {
    await closeClients(clients);
  }
  check("concurrency.transactions", failures === 0,
    `${failures} de ${CONCURRENT_TRANSACTIONS} transacciones concurrentes fallaron.`);
  check("concurrency.idempotent", inserted === 1,
    `la inserción idempotente concurrente registró ${inserted} filas nuevas en lugar de una.`);
}

async function verifySessionState(poolerUrl, directUrl, run) {
  const client = await openClient(poolerUrl);
  try {
    await client.query("begin");
    await client.query("set application_name = 'pooler-leak'");
    await client.query("commit");

    const direct = await openClient(directUrl);
    try {
      const { rows } = await direct.query(`select count(*)::int as total from pg_stat_activity
        where usename = $1 and application_name = 'pooler-leak'`, [run.user]);
      observe("session.application_name.backends", rows[0].total);
      check("session.set.persists.on.pooled.backend", rows[0].total >= 1,
        "el agrupador restableció el estado de sesión al confirmar la transacción.");
    } finally {
      await direct.end();
    }
  } finally {
    await client.end();
  }
}

async function verifySessionLocks(poolerUrl) {
  const owner = await openClient(poolerUrl);
  const contender = await openClient(poolerUrl);
  try {
    // A session-level advisory lock on a pooled backend survives COMMIT and blocks other clients.
    await owner.query("begin");
    const firstLock = await owner.query("select pg_try_advisory_lock($1) as acquired", [SESSION_LOCK_PROBE]);
    const contention = await contender.query("select pg_try_advisory_lock($1) as acquired", [SESSION_LOCK_PROBE]);
    check("session.advisory_lock.blocks.other.client",
      firstLock.rows[0].acquired === true && contention.rows[0].acquired === false,
      "un bloqueo asesor de sesión no se comportó como recurso global del servidor.");
    await owner.query("select pg_advisory_unlock_all()");
    await owner.query("commit");
    const released = await contender.query("select pg_try_advisory_lock($1) as acquired", [SESSION_LOCK_PROBE]);
    check("session.advisory_lock.released", released.rows[0].acquired === true,
      "el bloqueo asesor de sesión no se liberó al desbloquear explícitamente.");
    await contender.query("select pg_advisory_unlock_all()");
  } finally {
    await closeClients([owner, contender]);
  }
}

async function verifyConnectionRelease(directUrl, run) {
  await delay(1_000);
  const client = await openClient(directUrl);
  try {
    const { rows } = await client.query(`select count(*)::int as total,
      count(*) filter (where state = 'idle in transaction')::int as idle_in_transaction
      from pg_stat_activity where usename = $1 and pid <> pg_backend_pid()`, [run.user]);
    const { total, idle_in_transaction: idleInTransaction } = rows[0];
    observe("connections.server.after.clients", `${total} total / ${idleInTransaction} en transacción`);
    check("connections.released", idleInTransaction === 0 && total <= POOLER_POOL_SIZE,
      `quedaron ${idleInTransaction} conexiones en transacción y ${total} en total.`);
  } finally {
    await client.end();
  }
}

async function verifyScratchCounts(poolerUrl) {
  const client = await openClient(poolerUrl);
  let rows;
  try {
    ({ rows } = await client.query(`select (select count(*)::int from pooler_check_parent) as parent,
      (select count(*)::int from pooler_check_child) as child,
      (select count(*)::int from pooler_check_keys) as keys,
      (select value from pooler_check_counter where id = 1) as counter`));
  } finally {
    await client.end();
  }
  const [counts] = rows;
  check("writes.no.partial", counts.parent === 2 && counts.child === 0 && counts.keys === 1,
    `recuento inesperado de fixtures (${counts.parent}/${counts.child}/${counts.keys}).`);
  check("concurrency.serialized", counts.counter === CONCURRENT_TRANSACTIONS,
    `el contador serializado quedó en ${counts.counter} en lugar de ${CONCURRENT_TRANSACTIONS}.`);
}

async function runPoolerChecks(env, { checkInterrupted }) {
  const run = readTestRun(env);
  const password = decodeURIComponent(new URL(run.connectionString).password);
  const headEntry = expectedJournal().at(-1);
  const beforePersistent = await persistentState();

  await migrateTestDatabase(env);
  checkInterrupted();

  const directClient = await openClient(run.connectionString);
  let directState;
  try {
    directState = await readDatabaseState(directClient, { database: run.database, systemId: run.systemId });
  } finally {
    await directClient.end();
  }
  check("migration.direct", directState.journal.length === 17 && directState.journal.at(-1)?.hash === headEntry.hash
    && directState.journal.at(-1)?.when === headEntry.when,
  `el journal de la conexión directa no alcanzó ${HEAD_TAG} (${directState.journal.length} entradas).`);
  observe("postgres.version", directState.identity.version);

  let pooler;
  try {
    pooler = await startPooler(run, password);
    const poolMode = await logPoolMode(pooler.name);
    check("pooler.mode", poolMode === "transaction", `el agrupador no está en modo transacción (${poolMode}).`);
    await waitForPooler(pooler.url, checkInterrupted);

    await verifyIdentityThroughPooler(pooler.url, run);
    await verifySchema(directState, pooler.url, run);
    await prepareScratch(pooler.url);
    await verifyAdvisoryLock(pooler.url);
    await verifyRowLock(pooler.url);
    await verifyAtomicityAndForeignKeys(pooler.url);
    await verifyStatementTimeout(pooler.url);
    await verifyUnnamedStatements(pooler.url);
    await verifyConcurrency(pooler.url);
    await verifySessionState(pooler.url, run.connectionString, run);
    await verifySessionLocks(pooler.url);
    await verifyScratchCounts(pooler.url);
    checkInterrupted();
    await verifyConnectionRelease(run.connectionString, run);
  } finally {
    await stopPooler(pooler, run.runId);
  }

  const afterPersistent = await persistentState();
  check("persistent.untouched", beforePersistent === afterPersistent,
    "los contenedores persistentes DEV/TEST cambiaron de estado durante la verificación.");
  return checks.length;
}

export async function main() {
  if (process.env.TEST_DATABASE_URL || process.env.POSTGRES_TEST_RUN) {
    throw new Error("La verificación del agrupador aprovisiona su propia identidad. Retira TEST_DATABASE_URL y POSTGRES_TEST_RUN.");
  }
  const total = await withDisposablePostgres("pooler", runPoolerChecks);
  console.log(`[pooler] ${total} comprobaciones verificadas.`);
  for (const observation of observations) console.log(`[pooler] ${observation}`);
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[pooler] ERROR ${error instanceof Error ? error.message : "fallo inesperado"}`);
    process.exitCode = 1;
  });
}

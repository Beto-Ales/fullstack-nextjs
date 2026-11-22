import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertOwnedTestContainer, getPublishedTestPort, inspectTestContainer, migrateTestDatabase,
  openVerifiedTestConnection, testResourceNames, TEST_OWNER_LABEL, TEST_POSTGRES_DATA, TEST_POSTGRES_IMAGE, TEST_PURPOSES,
} from "./postgres-test-guard.mjs";

const exec = promisify(execFile);
const commands = {
  vitest: { purpose: "vitest", script: "../node_modules/vitest/vitest.mjs", args: ["run"] },
  integration: { purpose: "vitest", script: "../node_modules/vitest/vitest.mjs", args: ["run"] },
  e2e: { purpose: "e2e", script: "../node_modules/@playwright/test/cli.js", args: ["test"] },
  "e2e-pending": { purpose: "e2e-pending", script: "../node_modules/@playwright/test/cli.js", args: ["test"] },
  migrate: { purpose: "migrate" },
};

async function docker(args, env = process.env) {
  const { stdout } = await exec("docker", args, { env, timeout: 15_000, windowsHide: true });
  return stdout.trim();
}

function runBootstrapSql(containerId, database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", containerId, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-qAt"],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, timeout: 15_000 });
    let output = "";
    const error = () => reject(new Error("No se pudo registrar la identidad del PostgreSQL desechable."));
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("error", error);
    child.stdin.on("error", error);
    child.once("close", (code) => code === 0 ? resolve(output.trim()) : error());
    child.stdin.end(sql);
  });
}

async function waitForPostgres(containerId, database, checkInterrupted) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    checkInterrupted();
    try {
      await docker(["exec", containerId, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres", "-d", database]);
      return;
    } catch {
      await setTimeout(400);
    }
  }
  throw new Error("PostgreSQL desechable no estuvo disponible a tiempo.");
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

async function seedPendingRegulation(env) {
  const { client } = await openVerifiedTestConnection(env, ["e2e-pending"]);
  try {
    await client.query(`insert into academic_regulations (id, effective_from, cancellation_notice_days,
      monthly_cancellation_credits, monthly_recoveries, credit_expiration_months, max_class_capacity,
      max_eligible_consecutive_cancellations, previous_version_id, changes)
      select 'e2e-pending-regulation', (clock_timestamp() at time zone 'Europe/Copenhagen')::date-1,
        cancellation_notice_days, monthly_cancellation_credits, monthly_recoveries, credit_expiration_months,
        max_class_capacity, 3, id, '{}'::jsonb from academic_regulations where id='initial'`);
  } finally {
    await client.end();
  }
}

/**
 * @template Result
 * @param {string} purpose
 * @param {(env: Record<string, string | undefined>, controls: {
 *   runId: string, checkInterrupted: () => void, runChild: (script: string, args: string[]) => Promise<number>
 * }) => Promise<Result>} action
 * @param {Record<string, string | undefined>} inheritedEnv
 */
export async function withDisposablePostgres(purpose, action, inheritedEnv = process.env) {
  if (!TEST_PURPOSES.includes(purpose)) throw new Error("Tipo de ejecución PostgreSQL desechable inválido.");
  if (inheritedEnv.TEST_DATABASE_URL || inheritedEnv.POSTGRES_TEST_RUN) {
    throw new Error("El aprovisionador genera TEST_DATABASE_URL e identidad propias. Retira las asignaciones externas de prueba.");
  }

  const runId = randomBytes(16).toString("hex");
  const { name, database, user } = testResourceNames(runId);
  const password = randomBytes(32).toString("hex");
  const run = { runId, purpose };
  let attemptedStart = false;
  let child;
  let interruptCode;
  const onInterrupt = (signal) => {
    interruptCode ??= signal === "SIGINT" ? 130 : 143;
    child?.kill(signal);
  };
  const checkInterrupted = () => { if (interruptCode) throw new Error("Ejecución PostgreSQL interrumpida."); };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    attemptedStart = true;
    try {
      run.containerId = await docker(["run", "--detach", "--rm", "--pull", "never", "--name", name,
        "--label", `${TEST_OWNER_LABEL}=${runId}`, "--label", `${TEST_OWNER_LABEL}.purpose=${run.purpose}`,
        "--tmpfs", `${TEST_POSTGRES_DATA}:rw`, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_DB=${database}`,
        "--env", "POSTGRES_PASSWORD", TEST_POSTGRES_IMAGE],
      { ...inheritedEnv, POSTGRES_PASSWORD: randomBytes(32).toString("hex") });
    } catch {
      throw new Error("No se pudo crear PostgreSQL desechable. Comprueba Docker y la imagen local postgres:15.");
    }
    const container = await inspectTestContainer(run.containerId);
    assertOwnedTestContainer(container, run);
    const port = getPublishedTestPort(container);
    await waitForPostgres(run.containerId, database, checkInterrupted);
    checkInterrupted();

    // Bootstrap through Docker, in the instance we just verified. The suite does not receive this role or its password.
    run.systemId = await runBootstrapSql(run.containerId, database, `
      create role "${user}" login password '${password}';
      revoke connect, temp on database "${database}" from public;
      grant connect, temp, create on database "${database}" to "${user}";
      grant usage, create on schema public to "${user}";
      create schema test_provisioning;
      create table test_provisioning.run_identity (run_id text primary key, container_id text not null, purpose text not null);
      insert into test_provisioning.run_identity values ('${runId}', '${run.containerId}', '${run.purpose}');
      grant usage on schema test_provisioning to "${user}";
      grant select on test_provisioning.run_identity to "${user}";
      grant execute on function pg_catalog.pg_control_system() to "${user}";
      select system_identifier::text from pg_catalog.pg_control_system();`);

    const env = { ...inheritedEnv, TEST_DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`,
      POSTGRES_TEST_RUN: JSON.stringify(run) };
    checkInterrupted();
    const runChild = (script, args) => new Promise((resolve, reject) => {
      child = spawn(process.execPath, [script, ...args], { env, stdio: "inherit", windowsHide: true });
      child.once("error", () => reject(new Error("No se pudo arrancar el proceso de pruebas.")));
      child.once("close", (code) => resolve(interruptCode ?? code ?? 1));
    });
    const result = await action(env, { runId, checkInterrupted, runChild });
    checkInterrupted();
    return result;
  } catch (error) {
    if (interruptCode) return interruptCode;
    throw error;
  } finally {
    try {
      if (attemptedStart) {
        const own = await inspectTestContainer(run.containerId || name).catch(() => null);
        if (own) {
          assertOwnedTestContainer(own, run);
          try { await docker(["stop", "--time", "3", own.Id]); } catch {
            throw new Error("Docker no pudo retirar el contenedor desechable de esta ejecución.");
          }
          console.log(`[postgres-test] Recurso desechable retirado (${runId}).`);
        } else if (run.containerId) {
          throw new Error("No se pudo confirmar la limpieza del recurso PostgreSQL desechable.");
        }
      }
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  }
}

/** @param {Record<string, string | undefined>} inheritedEnv */
export async function runPostgresTests(mode, args = [], inheritedEnv = process.env) {
  if (!Object.hasOwn(commands, mode)) throw new Error("Modo requerido: vitest, integration, e2e, e2e-pending o migrate.");
  const command = commands[mode];
  return withDisposablePostgres(command.purpose, async (env, { runId, checkInterrupted, runChild }) => {
    // Keep the original DATABASE_URL for collision detection, then remove it from test processes.
    await migrateTestDatabase(env);
    delete env.DATABASE_URL;
    delete env.POSTGRES_TEST_SCOPE;
    env.AUTH_RATE_LIMIT_HMAC_KEY = randomBytes(32).toString("hex");
    env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = "5";
    env.AUTH_RATE_LIMIT_WINDOW_MINUTES = "15";
    if (mode === "integration") env.POSTGRES_TEST_SCOPE = "integration";
    checkInterrupted();
    console.log(`[postgres-test:${command.purpose}] PostgreSQL 15 desechable verificado y migrado (${runId}).`);
    if (!command.script) return 0;
    if (command.purpose === "e2e-pending") await seedPendingRegulation(env);
    if (command.purpose.startsWith("e2e")) env.E2E_PORT ??= await findLoopbackPort();
    checkInterrupted();
    return runChild(fileURLToPath(new URL(command.script, import.meta.url)), [...command.args, ...args]);
  }, inheritedEnv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPostgresTests(process.argv[2], process.argv.slice(3))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

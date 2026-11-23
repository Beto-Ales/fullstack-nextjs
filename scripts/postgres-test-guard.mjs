import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export const TEST_POSTGRES_IMAGE = "postgres:15";
export const TEST_POSTGRES_DATA = "/var/lib/postgresql/data";
export const TEST_OWNER_LABEL = "fullstack-nextjs.postgres-test";
export const TEST_PURPOSES = ["vitest", "e2e", "e2e-pending", "migrate", "rehearsal", "staging"];
const runIdPattern = /^[a-f0-9]{32}$/;
const containerIdPattern = /^[a-f0-9]{64}$/;
const reservedPorts = new Set([5432, 5433]);
const exec = promisify(execFile);

export function testResourceNames(runId) {
  return { name: `fullstack-nextjs-test-${runId}`, database: `project_test_${runId}`, user: `suite_${runId}` };
}

export async function inspectTestContainer(id) {
  try {
    const { stdout } = await exec("docker", ["inspect", "--type=container", id], { timeout: 10_000, windowsHide: true });
    return JSON.parse(stdout)[0];
  } catch {
    throw new Error("No se pudo verificar el contenedor PostgreSQL desechable en Docker.");
  }
}

export function assertOwnedTestContainer(container, { runId, purpose, containerId }) {
  const { name } = testResourceNames(runId);
  const labels = container?.Config?.Labels;
  const ownMounts = container?.Mounts ?? [];
  if (!containerIdPattern.test(container?.Id ?? "") || (containerId && container.Id !== containerId)
    || container.Name !== `/${name}` || labels?.[TEST_OWNER_LABEL] !== runId || labels?.[`${TEST_OWNER_LABEL}.purpose`] !== purpose
    || container.Config.Image !== TEST_POSTGRES_IMAGE || container.HostConfig?.AutoRemove !== true
    || !Object.hasOwn(container.HostConfig.Tmpfs ?? {}, TEST_POSTGRES_DATA)
    || ownMounts.some((mount) => mount.Type !== "tmpfs" || mount.Destination !== TEST_POSTGRES_DATA)) {
    throw new Error("El recurso Docker no pertenece a esta ejecución PostgreSQL desechable.");
  }
}

export function getPublishedTestPort(container) {
  const bindings = container.NetworkSettings?.Ports?.["5432/tcp"];
  const port = Number(bindings?.[0]?.HostPort);
  if (container.State?.Running !== true || bindings?.length !== 1 || bindings[0].HostIp !== "127.0.0.1"
    || !Number.isInteger(port) || port < 1024 || port > 65535 || reservedPorts.has(port)) {
    throw new Error("El contenedor de esta ejecución requiere un puerto PostgreSQL aislado en 127.0.0.1.");
  }
  return port;
}

function validateNoSharedDestination(url, env) {
  for (const key of ["DATABASE_URL", "DEV_DATABASE_URL", "PERSISTENT_TEST_DATABASE_URL", "PRODUCTION_DATABASE_URL"]) {
    if (!env[key]) continue;
    let other;
    try { other = new URL(env[key]); } catch {
      throw new Error(`No se pudo verificar la configuración de ${key}.`);
    }
    const isLocal = ["127.0.0.1", "localhost", "[::1]"].includes(other.hostname);
    if (other.href === url.href || (isLocal && (other.port || "5432") === url.port)) {
      throw new Error(`TEST_DATABASE_URL comparte destino con ${key}.`);
    }
  }
}

/** @param {Record<string, string | undefined>} env */
export function readTestRun(env = process.env, allowedPurposes = TEST_PURPOSES) {
  if (!env.TEST_DATABASE_URL) throw new Error("Falta TEST_DATABASE_URL. Usa un comando npm de pruebas que aprovisione PostgreSQL desechable.");
  let url;
  try { url = new URL(env.TEST_DATABASE_URL); } catch { throw new Error("TEST_DATABASE_URL no es una URL PostgreSQL válida."); }
  validateNoSharedDestination(url, env);
  if (!(url.protocol === "postgresql:" || url.protocol === "postgres:") || url.hostname !== "127.0.0.1"
    || !url.port || Number(url.port) < 1024 || reservedPorts.has(Number(url.port)) || url.search || url.hash) {
    throw new Error("TEST_DATABASE_URL debe usar exclusivamente el puerto TCP local aislado de la ejecución.");
  }

  let manifest;
  try { manifest = JSON.parse(env.POSTGRES_TEST_RUN ?? "null"); } catch { /* Validated below. */ }
  if (!manifest || typeof manifest.runId !== "string" || !runIdPattern.test(manifest.runId)
    || typeof manifest.containerId !== "string" || !containerIdPattern.test(manifest.containerId)
    || typeof manifest.systemId !== "string" || !/^[0-9]{1,20}$/.test(manifest.systemId)
    || !allowedPurposes.includes(manifest.purpose)) {
    throw new Error("Falta una identidad PostgreSQL desechable válida para este tipo de prueba.");
  }

  const { database, user } = testResourceNames(manifest.runId);
  if (url.pathname !== `/${database}` || url.username !== user || !containerIdPattern.test(url.password)) {
    throw new Error("TEST_DATABASE_URL no corresponde a la base y al rol de la ejecución registrada.");
  }
  return { runId: manifest.runId, containerId: manifest.containerId, purpose: manifest.purpose,
    systemId: manifest.systemId, connectionString: url.href, port: Number(url.port), database, user };
}

export async function assertTestConnection(client, run) {
  let actual;
  try {
    const result = await client.query(`select current_database() as database, current_user as username,
      session_user as login, inet_server_port() as port, current_setting('server_version_num')::int / 10000 as major,
      (select system_identifier::text from pg_catalog.pg_control_system()) as system_id,
      (select rolsuper from pg_catalog.pg_roles where rolname=current_user) as superuser,
      run_id, container_id, purpose from test_provisioning.run_identity`);
    if (result.rows.length === 1) actual = result.rows[0];
  } catch {
    throw new Error("PostgreSQL no acredita el marcador de aprovisionamiento de esta ejecución.");
  }
  if (actual?.database !== run.database || actual.username !== run.user || actual.login !== run.user
    || actual.port !== 5432 || actual.major !== 15 || actual.system_id !== run.systemId || actual.superuser !== false
    || actual.run_id !== run.runId || actual.container_id !== run.containerId || actual.purpose !== run.purpose) {
    throw new Error("La identidad real de PostgreSQL no coincide con el recurso desechable registrado.");
  }
}

/** @param {Record<string, string | undefined>} env */
export async function openVerifiedTestConnection(env = process.env, allowedPurposes = TEST_PURPOSES, dependencies = {}) {
  const run = readTestRun(env, allowedPurposes);
  const inspect = dependencies.inspect ?? inspectTestContainer;
  const container = await inspect(run.containerId);
  assertOwnedTestContainer(container, run);
  if (getPublishedTestPort(container) !== run.port) throw new Error("TEST_DATABASE_URL no apunta al puerto Docker de esta ejecución.");

  const createClient = dependencies.createClient ?? ((config) => new Client(config));
  const client = createClient({ connectionString: run.connectionString, ssl: false, connectionTimeoutMillis: 3_000 });
  try {
    try { await client.connect(); } catch { throw new Error("No se pudo conectar al PostgreSQL desechable registrado."); }
    await assertTestConnection(client, run);
    return { client, run };
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

export async function migrateTestDatabase(env, dependencies = {}) {
  const { client } = await openVerifiedTestConnection(env, TEST_PURPOSES, dependencies);
  try {
    await (dependencies.migrate ?? ((connection) => migrate(drizzle(connection), { migrationsFolder: "drizzle" })))(client);
  } finally {
    await client.end();
  }
}

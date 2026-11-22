import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import nextEnv from "@next/env";

const TEST_DATABASE_NAME_TOKEN = /(^|[_-])(test|testing|e2e|ci)([_-]|$)/i;
const DEFAULT_POSTGRES_PORT = "5432";

export function parseDatabaseUrl(name, rawUrl) {
  if (!rawUrl) {
    throw new Error(`${name} is required.`);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must start with postgres:// or postgresql://.`);
  }

  return parsed;
}

function normalizeHost(hostname) {
  return hostname.toLowerCase();
}

function normalizeDatabaseName(databaseName) {
  return decodeURIComponent(databaseName).toLowerCase();
}

export function getDatabaseName(parsedUrl) {
  return parsedUrl.pathname.replace(/^\/+/, "");
}

export function isTestDatabaseName(databaseName) {
  return TEST_DATABASE_NAME_TOKEN.test(databaseName);
}

function getEffectivePort(parsedUrl) {
  return parsedUrl.port || DEFAULT_POSTGRES_PORT;
}

export function getDatabaseIdentity(parsedUrl) {
  const databaseName = getDatabaseName(parsedUrl);
  if (!databaseName) {
    throw new Error("Database name is required in connection URL.");
  }

  return {
    host: normalizeHost(parsedUrl.hostname),
    port: getEffectivePort(parsedUrl),
    databaseName: normalizeDatabaseName(databaseName),
  };
}

function hasSameDatabaseIdentity(leftUrl, rightUrl) {
  const leftIdentity = getDatabaseIdentity(leftUrl);
  const rightIdentity = getDatabaseIdentity(rightUrl);

  return (
    leftIdentity.host === rightIdentity.host &&
    leftIdentity.port === rightIdentity.port &&
    leftIdentity.databaseName === rightIdentity.databaseName
  );
}

/**
 * @param {"dev" | "test" | string} mode
 * @param {Record<string, string | undefined>} [env]
 */
export function selectTargetUrl(mode, env = process.env) {
  const rawDatabaseUrl = env.DATABASE_URL;
  const rawTestDatabaseUrl = env.TEST_DATABASE_URL;

  if (mode === "dev") {
    const parsed = parseDatabaseUrl("DATABASE_URL", rawDatabaseUrl);
    const databaseName = getDatabaseName(parsed);
    if (isTestDatabaseName(databaseName)) {
      throw new Error("DATABASE_URL looks like a test database. Use db:migrate:test instead.");
    }

    if (rawTestDatabaseUrl) {
      const parsedTest = parseDatabaseUrl("TEST_DATABASE_URL", rawTestDatabaseUrl);
      if (hasSameDatabaseIdentity(parsed, parsedTest)) {
        throw new Error("DATABASE_URL and TEST_DATABASE_URL point to the same database. Refusing to migrate.");
      }
    }

    return rawDatabaseUrl;
  }

  if (mode === "test") {
    throw new Error("Usa npm run db:migrate:test para aprovisionar y verificar PostgreSQL desechable.");
  }

  throw new Error("Usage: node scripts/run-db-migrate.mjs <dev|test>");
}

export function formatTarget(mode, rawUrl) {
  const parsed = new URL(rawUrl);
  const port = getEffectivePort(parsed);
  const databaseName = getDatabaseName(parsed) || "<no-database>";
  return `[db:migrate:${mode}] Target => ${parsed.hostname}:${port}/${databaseName}`;
}

export function getDrizzleCommand(platform = process.platform) {
  return platform === "win32" ? "drizzle-kit.cmd" : "drizzle-kit";
}

export function resolveDrizzleExecutable(platform = process.platform, cwd = process.cwd()) {
  const command = getDrizzleCommand(platform);
  const localBinPath = join(cwd, "node_modules", ".bin", command);
  return existsSync(localBinPath) ? localBinPath : command;
}

/**
 * @param {NodeJS.Platform} [platform]
 * @param {string} drizzleExecutable
 * @param {Record<string, string | undefined>} [env]
 */
export function getDrizzleLaunch(platform = process.platform, drizzleExecutable, env = process.env) {
  if (platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/c", drizzleExecutable, "migrate"],
    };
  }

  return {
    command: drizzleExecutable,
    args: ["migrate"],
  };
}

export async function runDrizzleMigrate(rawUrl, options = {}) {
  if (options.mode === "test" || isTestDatabaseName(getDatabaseName(parseDatabaseUrl("DATABASE_URL", rawUrl)))) {
    throw new Error("Las migraciones de TEST requieren el aprovisionador PostgreSQL desechable.");
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;

  log(formatTarget(options.mode ?? "unknown", rawUrl));

  const drizzleExecutable = options.drizzleExecutable ?? resolveDrizzleExecutable(platform);
  const { command, args } = getDrizzleLaunch(platform, drizzleExecutable, env);

  const child = spawnImpl(command, args, {
    stdio: "inherit",
    env: {
      ...env,
      DATABASE_URL: rawUrl,
    },
  });

  return await new Promise((resolve) => {
    let resolved = false;

    function finalize(exitCode) {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(exitCode);
    }

    child.once("error", (error) => {
      const message = error instanceof Error ? error.message : "unknown process launch error";
      errorLog(`Failed to launch Drizzle migrate process: ${message}`);
      finalize(1);
    });

    child.once("close", (code) => {
      finalize(code ?? 1);
    });
  });
}

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 */
export async function main(argv = process.argv, env = process.env) {
  const mode = argv[2];
  if (mode === "test") {
    const { runPostgresTests } = await import("./run-postgres-tests.mjs");
    process.exitCode = await runPostgresTests("migrate", [], env);
    return;
  }

  const { loadEnvConfig } = nextEnv;
  loadEnvConfig(process.cwd());

  const selectedUrl = selectTargetUrl(mode, env);
  const exitCode = await runDrizzleMigrate(selectedUrl, {
    mode,
    platform: process.platform,
    env,
  });
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unexpected error while selecting migration target.";
    console.error(message);
    process.exitCode = 1;
  });
}

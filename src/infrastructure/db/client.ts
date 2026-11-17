import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { buildDatabaseConfig } from "@/src/infrastructure/db/config";
import * as schema from "@/src/infrastructure/db/schema";
import { getEnvironment } from "@/src/infrastructure/env";

const globalForDatabase = globalThis as unknown as {
  databasePool?: Pool;
};

function createPool() {
  return new Pool(buildDatabaseConfig(getEnvironment()));
}

export const pool = globalForDatabase.databasePool ?? createPool();

if (process.env.NODE_ENV !== "production") {
  globalForDatabase.databasePool = pool;
}

export const db = drizzle(pool, { schema });


import "server-only";

import type { RuntimeEnvironment } from "@/src/infrastructure/env";

export type DatabaseConfig = {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
};

export function buildDatabaseConfig(environment: Pick<RuntimeEnvironment, "DATABASE_URL">): DatabaseConfig {
  return {
    connectionString: environment.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  };
}


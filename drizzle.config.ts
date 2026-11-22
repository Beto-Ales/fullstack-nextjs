import { defineConfig } from "drizzle-kit";
import { getDatabaseName, isTestDatabaseName } from "./scripts/run-db-migrate.mjs";

function getRequiredDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for Drizzle commands. Set it explicitly or use npm run db:migrate:dev / npm run db:migrate:test.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must start with postgres:// or postgresql://.");
  }
  if (isTestDatabaseName(decodeURIComponent(getDatabaseName(parsed))) || databaseUrl === process.env.TEST_DATABASE_URL) {
    throw new Error("Las migraciones de TEST requieren npm run db:migrate:test y una base desechable verificada.");
  }

  return databaseUrl;
}

export default defineConfig({
  out: "./drizzle",
  schema: "./src/infrastructure/db/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: getRequiredDatabaseUrl(),
  },
  strict: true,
  verbose: true,
});


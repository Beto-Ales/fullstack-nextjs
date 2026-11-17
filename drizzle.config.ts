import { defineConfig } from "drizzle-kit";

const defaultDatabaseUrl = "postgresql://postgres:postgres@localhost:5432/fullstack_nextjs";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/infrastructure/db/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? defaultDatabaseUrl,
  },
  strict: true,
  verbose: true,
});


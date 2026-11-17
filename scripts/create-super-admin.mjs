import { randomUUID } from "node:crypto";

import nextEnv from "@next/env";
import bcrypt from "bcrypt";
import { Client } from "pg";
import { z } from "zod";

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const BCRYPT_COST = 12;

const superAdminSchema = z.object({
  email: z
    .string()
    .transform((value) => value.trim().replace(/\s+/g, "").toLowerCase())
    .pipe(z.string().email("Invalid email format.")),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `Password must not exceed ${PASSWORD_MAX_LENGTH} characters.`),
});

function readInput() {
  return {
    email: process.env.SUPER_ADMIN_EMAIL,
    password: process.env.SUPER_ADMIN_PASSWORD,
    databaseUrl: process.env.DATABASE_URL,
  };
}

async function main() {
  const { loadEnvConfig } = nextEnv;
  loadEnvConfig(process.cwd());

  const { email, password, databaseUrl } = readInput();
  if (!email || !password || !databaseUrl) {
    console.error("Missing required environment variables: DATABASE_URL, SUPER_ADMIN_EMAIL or SUPER_ADMIN_PASSWORD.");
    process.exitCode = 1;
    return;
  }

  const parsed = superAdminSchema.safeParse({ email, password });
  if (!parsed.success) {
    console.error("Invalid super admin input.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    connectionString: databaseUrl,
  });

  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

    const superAdminExistsResult = await client.query(
      "select id from users where role = 'SUPER_ADMIN' limit 1",
    );

    if (superAdminExistsResult.rowCount && superAdminExistsResult.rowCount > 0) {
      await client.query("ROLLBACK");
      console.error("A SUPER_ADMIN already exists. Aborting.");
      process.exitCode = 1;
      return;
    }

    const existingEmailResult = await client.query(
      "select id from users where email_normalized = $1 limit 1",
      [parsed.data.email],
    );

    if (existingEmailResult.rowCount && existingEmailResult.rowCount > 0) {
      await client.query("ROLLBACK");
      console.error("A user with that email already exists. Aborting.");
      process.exitCode = 1;
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);

    await client.query(
      `insert into users (id, email, email_normalized, password_hash, role, status, created_at, updated_at)
       values ($1, $2, $3, $4, 'SUPER_ADMIN', 'ACTIVE', now(), now())`,
      [randomUUID(), parsed.data.email, parsed.data.email, passwordHash],
    );

    await client.query("COMMIT");
    console.log("SUPER_ADMIN account created successfully.");
  } catch {
    await client.query("ROLLBACK");
    console.error("Failed to create SUPER_ADMIN account.");
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error("Failed to create SUPER_ADMIN account.");
  process.exitCode = 1;
});

import { Client } from "pg";

const SAFE_DATABASE_NAME = /(^|[_-])(test|testing|e2e|ci)([_-]|$)/i;
const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isSafeTestDatabaseName(databaseName: string): boolean {
  return SAFE_DATABASE_NAME.test(databaseName);
}

export function parseAndValidateTestDatabaseUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must start with postgres:// or postgresql://.");
  }

  const databaseName = parsed.pathname.replace(/^\/+/, "");
  if (!databaseName || !isSafeTestDatabaseName(databaseName)) {
    throw new Error("TEST_DATABASE_URL database name must include test/testing/e2e/ci as a full token.");
  }

  if (!SAFE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("TEST_DATABASE_URL host is not allowed. Only localhost/127.0.0.1/::1 are accepted.");
  }

  return parsed;
}

export function getVerifiedTestDatabaseUrl(): string {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  }

  parseAndValidateTestDatabaseUrl(testDatabaseUrl);
  process.env.DATABASE_URL = testDatabaseUrl;

  return testDatabaseUrl;
}

async function assertSafeConnectedDatabase(client: Client): Promise<void> {
  const result = await client.query<{ current_database: string }>("select current_database()");
  const databaseName = result.rows[0]?.current_database ?? "";

  if (!isSafeTestDatabaseName(databaseName)) {
    throw new Error("Refusing destructive test operation: connected database does not look like a test database.");
  }
}

export async function createVerifiedTestClient(): Promise<Client> {
  const connectionString = getVerifiedTestDatabaseUrl();
  const client = new Client({ connectionString });
  await client.connect();
  await assertSafeConnectedDatabase(client);
  return client;
}

export async function resetTestDatabase(client: Client): Promise<void> {
  await assertSafeConnectedDatabase(client);

  const tables = await client.query<{ tablename: string }>(`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> '__drizzle_migrations'
  `);

  if (!tables.rows.length) {
    return;
  }

  const tableList = tables.rows.map(({ tablename }) => `"${tablename}"`).join(", ");
  await client.query(`truncate table ${tableList} restart identity cascade`);
}

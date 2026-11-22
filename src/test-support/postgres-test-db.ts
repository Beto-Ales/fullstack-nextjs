import type { Client } from "pg";
import { assertTestConnection, openVerifiedTestConnection } from "../../scripts/postgres-test-guard.mjs";

const verifiedClients = new WeakMap<Client, Awaited<ReturnType<typeof openVerifiedTestConnection>>["run"]>();
let publishedUrl: string | undefined;

export async function createVerifiedTestClient(): Promise<Client> {
  const env = { ...process.env };
  if (publishedUrl && env.DATABASE_URL === publishedUrl) delete env.DATABASE_URL;
  const { client, run } = await openVerifiedTestConnection(env, ["vitest", "e2e", "e2e-pending"]);
  if (publishedUrl && run.connectionString !== publishedUrl) {
    await client.end();
    throw new Error("La base verificada no puede cambiar durante un proceso de pruebas.");
  }
  publishedUrl = run.connectionString;
  process.env.DATABASE_URL = publishedUrl;
  verifiedClients.set(client, run);
  return client;
}

export async function resetTestDatabase(client: Client): Promise<void> {
  const run = verifiedClients.get(client);
  if (run?.purpose !== "vitest") throw new Error("La limpieza requiere una conexión Vitest desechable previamente verificada.");
  await assertTestConnection(client, run);

  const tables = await client.query<{ tablename: string }>(`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> '__drizzle_migrations'
  `);

  if (!tables.rows.length) {
    return;
  }

  const tableList = tables.rows.map(({ tablename }) => `public."${tablename.replace(/"/g, '""')}"`).join(", ");
  const hasRegulations = tables.rows.some(({ tablename }) => tablename === "academic_regulations");
  await client.query("begin");
  try {
    if (hasRegulations) {
      await client.query(`
        create temporary table test_initial_regulation on commit drop as
        select * from academic_regulations where id = 'initial'
      `);
    }
    await client.query(`truncate table ${tableList} restart identity cascade`);
    if (hasRegulations) {
      await client.query("insert into academic_regulations select * from test_initial_regulation");
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

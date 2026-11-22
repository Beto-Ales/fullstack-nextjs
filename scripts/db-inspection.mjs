import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client } from "pg";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")).entries;
const fingerprints = JSON.parse(readFileSync(new URL("./db-schema-fingerprints.json", import.meta.url), "utf8"));
const beginReadOnly = "begin isolation level repeatable read read only";
const inspectionSettings = "set local search_path=pg_catalog; set local statement_timeout='8s'; set local lock_timeout='2s'";
const identitySql = `
  select json_build_object('database', current_database(),
    'version', current_setting('server_version'), 'major', current_setting('server_version_num')::int / 10000,
    'systemId', (select system_identifier::text from pg_control_system()),
    'readOnly', current_setting('transaction_read_only') = 'on',
    'journalExists', to_regclass('drizzle.__drizzle_migrations') is not null) as value
`;
const journalSql = `
  select coalesce(json_agg(json_build_object('id', id, 'hash', hash, 'when', created_at::text) order by id), '[]') as value
  from drizzle.__drizzle_migrations
`;
const catalogSql = `
  with relations as (
    select c.*, n.nspname, format('%I.%I', n.nspname, c.relname) as qualified
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public', 'drizzle')
  ), objects(kind, name, definition) as (
    select 'schema', nspname, '' from pg_namespace where nspname in ('public', 'drizzle')
    union all
    select 'relation', qualified, concat(relkind, ':', relpersistence, ':', relrowsecurity, ':', relforcerowsecurity,
      ':', case when relkind in ('v','m') then pg_get_viewdef(oid) end)
      from relations where relkind not in ('i','I')
    union all
    select 'column', r.qualified || '.' || quote_ident(a.attname),
      concat(a.attnum, ':', format_type(a.atttypid,a.atttypmod), ':', a.attnotnull, ':', a.attidentity, ':', a.attgenerated,
        ':', pg_get_expr(d.adbin,d.adrelid), ':', col.collname)
      from relations r join pg_attribute a on a.attrelid=r.oid
      left join pg_attrdef d on d.adrelid=r.oid and d.adnum=a.attnum
      left join pg_collation col on col.oid=a.attcollation
      where r.relkind in ('r','p','v','m','f') and a.attnum>0 and not a.attisdropped
    union all
    select 'constraint', r.qualified || '.' || quote_ident(c.conname), concat(pg_get_constraintdef(c.oid), ':', c.convalidated)
      from relations r join pg_constraint c on c.conrelid=r.oid
    union all
    select 'index', r.qualified, concat(pg_get_indexdef(r.oid), ':', i.indisvalid, ':', i.indisready)
      from relations r join pg_index i on i.indexrelid=r.oid
    union all
    select 'enum', format('%I.%I',n.nspname,t.typname), json_agg(e.enumlabel order by e.enumsortorder)::text
      from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
      where n.nspname in ('public','drizzle') group by n.nspname,t.typname
    union all
    select 'function', format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),
        replace(pg_get_functiondef(p.oid), chr(13)||chr(10), chr(10))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','drizzle') and p.prokind in ('f','p','w')
    union all
    select 'trigger', r.qualified || '.' || quote_ident(t.tgname), concat(pg_get_triggerdef(t.oid), ':', t.tgenabled)
      from relations r join pg_trigger t on t.tgrelid=r.oid where not t.tgisinternal
    union all
    select 'internal trigger state', r.qualified, concat(c.conname, ':', t.tgenabled)
      from relations r join pg_trigger t on t.tgrelid=r.oid join pg_constraint c on c.oid=t.tgconstraint
      where t.tgisinternal and t.tgenabled <> 'O'
    union all
    select 'row security policy', r.qualified || '.' || quote_ident(p.polname),
      concat(p.polcmd, ':', p.polpermissive, ':', pg_get_expr(p.polqual,p.polrelid), ':', pg_get_expr(p.polwithcheck,p.polrelid))
      from relations r join pg_policy p on p.polrelid=r.oid
    union all
    select 'sequence', r.qualified, concat(s.seqtypid::regtype, ':', s.seqstart, ':', s.seqincrement,
        ':', s.seqmax, ':', s.seqmin, ':', s.seqcache, ':', s.seqcycle, ':', owner.qualified, '.', a.attname)
      from relations r join pg_sequence s on s.seqrelid=r.oid
      left join pg_depend d on d.classid='pg_class'::regclass and d.objid=r.oid and d.deptype in ('a','i')
      left join relations owner on owner.oid=d.refobjid
      left join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
  )
  select coalesce(json_agg(json_build_array(kind,name,definition)
    order by kind collate "C", name collate "C", definition collate "C"), '[]') as value from objects
`;

export function expectedJournal() {
  return readMigrationFiles({ migrationsFolder }).map(({ hash, folderMillis }, index) => ({
    tag: journal[index].tag, hash, when: String(folderMillis),
  }));
}

export async function readDatabaseState(client, expectedIdentity) {
  await client.query(beginReadOnly);
  try {
    await client.query(inspectionSettings);
    const readValue = async (query) => (await client.query(query)).rows[0].value;
    const identity = await readValue(identitySql);
    assertIdentity(identity, expectedIdentity);
    return { identity, journal: identity.journalExists ? await readValue(journalSql) : [], catalog: await readValue(catalogSql) };
  } finally {
    await client.query("rollback");
  }
}

function assertIdentity(identity, expected) {
  if (!identity.readOnly || identity.major !== 15 || identity.database !== expected.database
    || (expected.systemId !== undefined && identity.systemId !== expected.systemId)) {
    throw new Error("La identidad PostgreSQL 15 en solo lectura no coincide con el destino esperado.");
  }
}

export function schemaFingerprint(catalog) {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

/** @param {{ ready?: boolean, hmacKey?: string, maxAttempts?: string, windowMinutes?: string }} options */
export function checkDatabaseState(state, options = {}) {
  const { ready = false, hmacKey, maxAttempts, windowMinutes } = options;
  const expected = expectedJournal();
  const catalogHash = schemaFingerprint(state.catalog);
  const errors = [];
  const matches = state.journal.length <= expected.length && state.journal.every((row, index) =>
    row.hash === expected[index].hash && row.when === expected[index].when);
  const applied = matches ? expected.slice(0, state.journal.length) : [];
  const last = applied.at(-1)?.tag ?? null;
  if (!matches || !state.identity.journalExists || !last) {
    errors.push("Journal ausente, vacío o distinto de un prefijo exacto del repositorio.");
  } else if (fingerprints[last] !== catalogHash) {
    errors.push("El catálogo no coincide con el esquema de referencia para el journal aplicado.");
  }
  const pending = matches ? expected.slice(applied.length).map(({ tag }) => tag) : null;
  if (ready && pending?.length !== 0) errors.push("La aplicación requiere el journal completo.");
  if (ready && (typeof hmacKey !== "string" || !/^[0-9a-f]{64}$/i.test(hmacKey))) {
    errors.push("AUTH_RATE_LIMIT_HMAC_KEY es obligatoria y debe contener 32 bytes en hexadecimal.");
  }
  if (ready) {
    for (const [name, value, max] of [
      ["AUTH_RATE_LIMIT_MAX_ATTEMPTS", maxAttempts, 100],
      ["AUTH_RATE_LIMIT_WINDOW_MINUTES", windowMinutes, 60],
    ]) {
      if (value !== undefined && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > max)) {
        errors.push(`${name} debe ser un entero entre 1 y ${max}.`);
      }
    }
  }
  return { database: state.identity.database, version: state.identity.version, last, pending, catalogHash, errors };
}

function inspectLocal(mode) {
  const service = `postgres_${mode}`;
  const database = mode === "dev" ? "fullstack_nextjs" : "fullstack_nextjs_test";
  const port = mode === "dev" ? 5432 : 5433;
  const docker = (args, input) => execFileSync("docker", args, {
    input, encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  const format = '{{.Id}} {{.State.Running}} {{.Config.Image}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{range index .NetworkSettings.Ports "5432/tcp"}}{{.HostIp}}:{{.HostPort}} {{end}}{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}';
  const [containerId, ...facts] = docker(["inspect", "--type=container", "--format", format, `fullstack_nextjs_${service}`]).split(/\s+/);
  if (!/^[0-9a-f]{64}$/.test(containerId) || facts.join(" ") !==
    `true postgres:15 fullstack-nextjs ${service} 127.0.0.1:${port} volume:fullstack-nextjs_${service}_data:/var/lib/postgresql/data`) {
    throw new Error("El servicio Docker local no coincide con el destino Compose esperado.");
  }
  const sql = `${beginReadOnly}; ${inspectionSettings};
    ${identitySql};
    select to_regclass('drizzle.__drizzle_migrations') is not null as h07_has_journal \\gset
    \\if :h07_has_journal
    ${journalSql};
    \\else
    select '[]';
    \\endif
    ${catalogSql};
    rollback;`;
  const rows = docker(["exec", "-i", containerId, "sh", "-c",
    'exec psql -X -w -qAt -v ON_ERROR_STOP=1 -h /var/run/postgresql -p 5432 -U "$POSTGRES_USER" -d "$1"',
    "h07-inspection", database], sql);
  const [identity, applied, catalog] = rows.split(/\r?\n/).map((line) => JSON.parse(line));
  assertIdentity(identity, { database });
  return { identity, journal: applied, catalog };
}

function parseTarget(raw) {
  try {
    const url = new URL(raw);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (["postgres:", "postgresql:"].includes(url.protocol) && url.hostname
      && /^[\w.-]+$/.test(database) && !url.hash
      && [...url.searchParams.keys()].every((key) => ["sslmode", "sslrootcert", "sslcert", "sslkey"].includes(key))) {
      return { url, database, endpoint: `${url.hostname}:${url.port || "5432"}/${database}` };
    }
  } catch { /* Report only the variable name, never its value. */ }
  throw new Error("Se requiere una URL PostgreSQL explícita, con base y sin parámetros de redirección.");
}

export async function inspectExplicit(env, ready) {
  const target = parseTarget(env.DATABASE_INSPECTION_URL);
  if (target.database !== env.DB_EXPECTED_NAME || !/^[0-9]{1,20}$/.test(env.DB_EXPECTED_SYSTEM_ID ?? "")) {
    throw new Error("Se requieren DB_EXPECTED_NAME y DB_EXPECTED_SYSTEM_ID del destino autorizado.");
  }
  if (ready && parseTarget(env.DATABASE_URL).endpoint !== target.endpoint) {
    throw new Error("DATABASE_URL de la aplicación difiere del destino explícito de inspección.");
  }
  const client = new Client({ connectionString: target.url.href, connectionTimeoutMillis: 3000, query_timeout: 12000 });
  try {
    await client.connect();
    return await readDatabaseState(client, { database: target.database, systemId: env.DB_EXPECTED_SYSTEM_ID });
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !["dev", "test", "connection", "ready"].includes(mode)) {
      throw new Error("Uso: npm run db:inspect -- dev|test|connection|ready");
    }
    const ready = mode === "ready";
    const state = mode === "dev" || mode === "test" ? inspectLocal(mode) : await inspectExplicit(process.env, ready);
    const report = checkDatabaseState(state, { ready, hmacKey: process.env.AUTH_RATE_LIMIT_HMAC_KEY,
      maxAttempts: process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, windowMinutes: process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } catch {
    console.error("Inspección PostgreSQL cancelada. Comprueba modo, conectividad e identidad explícita. Usa dev, test, connection o ready.");
    process.exitCode = 1;
  }
}

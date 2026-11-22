import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";
import {
  migrateTestDatabase, openVerifiedTestConnection, readTestRun, TEST_OWNER_LABEL, TEST_POSTGRES_DATA,
} from "../../scripts/postgres-test-guard.mjs";
import { runPostgresTests } from "../../scripts/run-postgres-tests.mjs";

const runId = "a".repeat(32);
const containerId = "c".repeat(64);
const password = "b".repeat(64);
const systemId = "1234567890";
const user = `suite_${runId}`;
const database = `project_test_${runId}`;
const url = `postgresql://${user}:${password}@127.0.0.1:55435/${database}`;
const makeEnv = (purpose = "vitest") => ({
  TEST_DATABASE_URL: url, POSTGRES_TEST_RUN: JSON.stringify({ runId, containerId, systemId, purpose }),
});

function makeProbe() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [{ database, username: user, login: user, port: 5432, major: 15,
      system_id: systemId, superuser: false, run_id: runId, container_id: containerId, purpose: "vitest" }] }),
  };
}

function makeContainer() {
  return {
    Id: containerId, Name: `/fullstack-nextjs-test-${runId}`,
    Config: { Image: "postgres:15", Labels: { [TEST_OWNER_LABEL]: runId, [`${TEST_OWNER_LABEL}.purpose`]: "vitest" } },
    Mounts: [], HostConfig: { AutoRemove: true, Tmpfs: { [TEST_POSTGRES_DATA]: "rw" } },
    State: { Running: true }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55435" }] } },
  };
}

function childEnv() {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  delete env.DATABASE_URL;
  delete env.POSTGRES_TEST_RUN;
  return env;
}

describe("PostgreSQL test isolation guards", () => {
  it.each([
    [{}, /Falta TEST_DATABASE_URL/],
    [{ TEST_DATABASE_URL: "postgresql://suite:secret@127.0.0.1:5432/dev" }, /puerto TCP local aislado/],
    [{ TEST_DATABASE_URL: "postgresql://suite:secret@127.0.0.1:5433/persistent_test" }, /puerto TCP local aislado/],
    [{ TEST_DATABASE_URL: "postgresql://suite:secret@production.example:5432/db" }, /puerto TCP local aislado/],
    [{ TEST_DATABASE_URL: "postgresql://suite:secret@127.0.0.1:55435/persistent_test" }, /Falta una identidad/],
    [{ ...makeEnv(), TEST_DATABASE_URL: url.replace(database, "similar_test") }, /base y al rol/],
    [{ ...makeEnv(), TEST_DATABASE_URL: `${url}?host=elsewhere` }, /puerto TCP local aislado/],
    [{ ...makeEnv(), DATABASE_URL: url }, /comparte destino con DATABASE_URL/],
    [{ ...makeEnv(), PERSISTENT_TEST_DATABASE_URL: "postgresql://user:secret@localhost:55435/other" }, /comparte destino/],
    [{ ...makeEnv(), POSTGRES_TEST_RUN: "true" }, /Falta una identidad/],
    [{ ...makeEnv(), POSTGRES_TEST_RUN: "{invalid" }, /Falta una identidad/],
  ])("rejects an unsafe environment before Docker, PostgreSQL or migration", async (env, message) => {
    const createClient = vi.fn();
    const inspect = vi.fn();
    const migrate = vi.fn();
    await expect(migrateTestDatabase(env, { createClient, inspect, migrate })).rejects.toThrow(message);
    expect(inspect).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("checks test purpose and rejects external configuration before provisioning", async () => {
    expect(() => readTestRun(makeEnv(), ["e2e"])).toThrow(/este tipo de prueba/);
    await expect(runPostgresTests("vitest", [], makeEnv())).rejects.toThrow(/asignaciones externas/);
  });

  it("rejects a false Docker owner, shared mount or different mapped port before opening PostgreSQL", async () => {
    const createClient = vi.fn();
    for (const container of [
      { ...makeContainer(), Id: "d".repeat(64) },
      { ...makeContainer(), Mounts: [{ Type: "volume", Destination: TEST_POSTGRES_DATA }] },
      { ...makeContainer(), NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55436" }] } } },
    ]) {
      await expect(openVerifiedTestConnection(makeEnv(), ["vitest"], { inspect: async () => container, createClient })).rejects.toThrow();
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an old identity whose disposable container no longer exists", async () => {
    const inspect = vi.fn().mockRejectedValue(new Error("No se pudo verificar el contenedor"));
    const createClient = vi.fn();
    await expect(openVerifiedTestConnection(makeEnv(), ["vitest"], { inspect, createClient })).rejects.toThrow(/verificar el contenedor/);
    expect(inspect).toHaveBeenCalledWith(containerId);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    { run_id: "d".repeat(32) }, { system_id: "789012" }, { username: "postgres" }, { login: "postgres" },
    { superuser: true }, { major: 17 }, { purpose: "e2e" }, { container_id: "d".repeat(64) },
  ])("rejects a mismatched database marker using only its read query", async (change) => {
    const client = makeProbe();
    const { rows: [record] } = await client.query();
    client.query.mockClear().mockResolvedValue({ rows: [{ ...record, ...change }] });
    const migrate = vi.fn();
    await expect(migrateTestDatabase(makeEnv(), { inspect: async () => makeContainer(), createClient: () => client, migrate }))
      .rejects.toThrow(/identidad real/);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toMatch(/^select /i);
    expect(migrate).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("closes a failed connection and hides driver diagnostics", async () => {
    const client = makeProbe();
    client.connect.mockRejectedValue(new Error(`Unreachable ${url}`));
    const migrate = vi.fn();
    await expect(migrateTestDatabase(makeEnv(), { inspect: async () => makeContainer(), createClient: () => client, migrate }))
      .rejects.toThrow(/^No se pudo conectar al PostgreSQL desechable registrado\.$/);
    expect(client.query).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("passes the same verified connection to the migrator after checking provenance", async () => {
    const client = makeProbe();
    const migrate = vi.fn().mockResolvedValue(undefined);
    await migrateTestDatabase(makeEnv(), { inspect: async () => makeContainer(), createClient: () => client, migrate });
    expect(migrate).toHaveBeenCalledWith(client);
    expect(client.query.mock.invocationCallOrder[0]).toBeLessThan(migrate.mock.invocationCallOrder[0]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("refuses a direct cleanup call without issuing any SQL", async () => {
    const query = vi.fn();
    await expect(resetTestDatabase({ query } as unknown as Client)).rejects.toThrow(/previamente verificada/);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses direct fixture creation when the connection is missing", async () => {
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    try { await expect(createVerifiedTestClient()).rejects.toThrow(/Falta TEST_DATABASE_URL/); } finally { vi.unstubAllEnvs(); }
  });

  it("fails a direct Vitest integration instead of silently skipping", async () => {
    await expect(promisify(execFile)(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
      "src/application/academic/habitual-assignment.integration.test.ts"], { env: childEnv(), timeout: 12_000 }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Falta TEST_DATABASE_URL") });
  }, 15_000);

  it("rejects Playwright without an explicit test connection before starting Next", async () => {
    await expect(promisify(execFile)(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "home.spec.ts"],
      { env: childEnv(), timeout: 12_000 }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Falta TEST_DATABASE_URL") });
  }, 15_000);

  it("rejects a pre-existing HTTP server without adopting it", async () => {
    const listener = vi.fn((_request, response) => response.end("foreign server"));
    const server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(promisify(execFile)(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "home.spec.ts"], {
        env: { ...childEnv(), ...makeEnv("e2e"), E2E_PORT: String(port) }, timeout: 12_000,
      })).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/already used|already in use/i) });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);
});

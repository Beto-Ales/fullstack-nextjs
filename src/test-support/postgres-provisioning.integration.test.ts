import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createVerifiedTestClient, resetTestDatabase } from "@/src/test-support/postgres-test-db";

it("verifies the real run marker, ordered journal, and cleanup limited to fixtures", async () => {
  const client = await createVerifiedTestClient();
  try {
    const { rows: [role] } = await client.query(`select current_user as username,
      (select rolsuper from pg_roles where rolname=current_user) as superuser,
      has_table_privilege(current_user, 'test_provisioning.run_identity', 'UPDATE') as can_change_marker`);
    expect(role).toEqual({ username: expect.stringMatching(/^suite_[a-f0-9]{32}$/), superuser: false, can_change_marker: false });
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] };
    const expected = journal.entries.map(({ tag, when }) => ({
      hash: createHash("sha256").update(readFileSync(`drizzle/${tag}.sql`)).digest("hex"), created_at: String(when),
    }));
    const readJournal = () => client.query("select hash, created_at from drizzle.__drizzle_migrations order by id");
    expect((await readJournal()).rows).toEqual(expected);
    const marker = (await client.query("select * from test_provisioning.run_identity")).rows;
    expect(marker).toEqual([expect.objectContaining({ purpose: "vitest" })]);

    await client.query("insert into users (id,email,email_normalized,password_hash,role) values ('fixture','fixture@example.com','fixture@example.com','hash','STUDENT')");
    await resetTestDatabase(client);
    expect((await client.query("select id from users where id='fixture'")).rowCount).toBe(0);
    expect((await client.query("select id from academic_regulations where id='initial'")).rowCount).toBe(1);
    expect((await client.query("select * from test_provisioning.run_identity")).rows).toEqual(marker);
    expect((await readJournal()).rows).toEqual(expected);
  } finally {
    await client.end();
  }
});

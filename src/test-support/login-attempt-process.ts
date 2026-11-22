import { createVerifiedTestClient } from "@/src/test-support/postgres-test-db";

const email = process.argv[2];
if (!email) throw new Error("Missing synthetic login identity.");

const client = await createVerifiedTestClient();
try {
  const { db, pool } = await import("@/src/infrastructure/db/client");
  try {
    const { reserveLoginAttempt } = await import("@/src/infrastructure/security/auth-rate-limit");
    const admitted = Boolean(await reserveLoginAttempt(db, email));
    console.log(JSON.stringify({ pid: process.pid, admitted }));
  } finally {
    await pool.end();
  }
} finally {
  await client.end();
}

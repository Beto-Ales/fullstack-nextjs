import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openVerifiedTestConnection } from "./postgres-test-guard.mjs";

try {
  const port = Number(process.env.E2E_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT no es válido.");
  const { client, run } = await openVerifiedTestConnection(process.env, ["e2e", "e2e-pending"]);
  await client.end();

  const next = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  const child = spawn(process.execPath, [next, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, DATABASE_URL: run.connectionString, NODE_ENV: "development" }, stdio: "inherit", windowsHide: true,
  });
  const onInterrupt = () => child.kill("SIGINT");
  const onTerminate = () => child.kill("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("No se pudo iniciar Next.js para E2E.")));
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

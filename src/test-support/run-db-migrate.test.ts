import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

async function loadModule() {
  return import("../../scripts/run-db-migrate.mjs");
}

describe("run-db-migrate wrapper", () => {
  it("selects drizzle-kit.cmd on Windows", async () => {
    const { getDrizzleCommand } = await loadModule();
    expect(getDrizzleCommand("win32")).toBe("drizzle-kit.cmd");
  });

  it("selects drizzle-kit on Unix", async () => {
    const { getDrizzleCommand } = await loadModule();
    expect(getDrizzleCommand("linux")).toBe("drizzle-kit");
  });

  it("builds Windows launch command through cmd.exe with separated arguments", async () => {
    const { getDrizzleLaunch } = await loadModule();
    const launch = getDrizzleLaunch("win32", "drizzle-kit.cmd", { ComSpec: "C:\\Windows\\System32\\cmd.exe" });

    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args).toEqual(["/d", "/c", "drizzle-kit.cmd", "migrate"]);
  });

  it("builds Unix launch command directly", async () => {
    const { getDrizzleLaunch } = await loadModule();
    const launch = getDrizzleLaunch("linux", "drizzle-kit", {});

    expect(launch.command).toBe("drizzle-kit");
    expect(launch.args).toEqual(["migrate"]);
  });

  it("preserves executable paths containing spaces on Windows", async () => {
    const { getDrizzleLaunch } = await loadModule();
    const launch = getDrizzleLaunch("win32", "C:\\Program Files\\Drizzle\\drizzle-kit.cmd", {
      ComSpec: "cmd.exe",
    });

    expect(launch.args).toEqual(["/d", "/c", "C:\\Program Files\\Drizzle\\drizzle-kit.cmd", "migrate"]);
  });

  it("treats same host/port/db with different users as the same target", async () => {
    const { selectTargetUrl } = await loadModule();
    expect(() =>
      selectTargetUrl("dev", {
        DATABASE_URL: "postgresql://dev_user:dev_pass@localhost:5432/fullstack_nextjs",
        TEST_DATABASE_URL: "postgresql://test_user:test_pass@localhost:5432/fullstack_nextjs",
      }),
    ).toThrowError("point to the same database");
  });

  it("treats same identity with different query params as the same target", async () => {
    const { selectTargetUrl } = await loadModule();
    expect(() =>
      selectTargetUrl("dev", {
        DATABASE_URL: "postgresql://user:pass@localhost:5432/fullstack_nextjs?sslmode=disable",
        TEST_DATABASE_URL: "postgresql://user:pass@localhost:5432/fullstack_nextjs?application_name=tests",
      }),
    ).toThrowError("point to the same database");
  });

  it("treats omitted port and explicit 5432 as the same target", async () => {
    const { selectTargetUrl } = await loadModule();
    expect(() =>
      selectTargetUrl("dev", {
        DATABASE_URL: "postgresql://user:pass@localhost/fullstack_nextjs",
        TEST_DATABASE_URL: "postgresql://user:pass@localhost:5432/fullstack_nextjs",
      }),
    ).toThrowError("point to the same database");
  });

  it("allows different database names", async () => {
    const { selectTargetUrl } = await loadModule();
    const selected = selectTargetUrl("dev", {
      DATABASE_URL: "postgresql://dev_user:dev_pass@localhost:5432/fullstack_nextjs",
      TEST_DATABASE_URL: "postgresql://test_user:test_pass@localhost:5432/fullstack_nextjs_test",
    });
    expect(selected).toBe("postgresql://dev_user:dev_pass@localhost:5432/fullstack_nextjs");
  });

  it("rejects arbitrary TEST migration targets before spawning Drizzle", async () => {
    const { selectTargetUrl, runDrizzleMigrate } = await loadModule();
    const TEST_DATABASE_URL = "postgresql://user:pass@localhost:5433/persistent_test";
    const spawnImpl = vi.fn();
    expect(() => selectTargetUrl("test", { TEST_DATABASE_URL })).toThrow(/db:migrate:test/);
    await expect(runDrizzleMigrate(TEST_DATABASE_URL, { mode: "test", spawnImpl })).rejects.toThrow(/aprovisionador/);
    await expect(runDrizzleMigrate(TEST_DATABASE_URL, { mode: "dev", spawnImpl })).rejects.toThrow(/aprovisionador/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("prints target without username and password", async () => {
    const { formatTarget } = await loadModule();
    const message = formatTarget("test", "postgresql://test_user:super-secret@localhost:5433/fullstack_nextjs_test");
    expect(message).toContain("[db:migrate:test] Target => localhost:5433/fullstack_nextjs_test");
    expect(message).not.toContain("test_user");
    expect(message).not.toContain("super-secret");
  });

  it("handles spawn launch errors with non-zero exit code and no double finalization", async () => {
    const { runDrizzleMigrate } = await loadModule();

    const child = new EventEmitter();
    const spawnImpl = vi.fn<(...args: unknown[]) => EventEmitter>(() => child);
    const log = vi.fn();
    const errorLog = vi.fn();

    const exitCodePromise = runDrizzleMigrate("postgresql://user:pass@localhost:5432/fullstack_nextjs", {
      mode: "dev",
      spawnImpl,
      platform: "win32",
      drizzleExecutable: "drizzle-kit.cmd",
      env: {},
      log,
      errorLog,
    });

    child.emit("error", new Error("spawn failed"));
    child.emit("close", 0);

    await expect(exitCodePromise).resolves.toBe(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toContain("Failed to launch Drizzle migrate process");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("cmd.exe");
    expect(spawnImpl.mock.calls[0]?.[1]).toEqual(["/d", "/c", "drizzle-kit.cmd", "migrate"]);
  });

  it("propagates non-zero exit code from drizzle", async () => {
    const { runDrizzleMigrate } = await loadModule();

    const child = new EventEmitter();
    const spawnImpl = vi.fn<(...args: unknown[]) => EventEmitter>(() => child);
    const log = vi.fn();
    const errorLog = vi.fn();

    const exitCodePromise = runDrizzleMigrate("postgresql://user:pass@localhost:5432/fullstack_nextjs", {
      mode: "dev",
      spawnImpl,
      platform: "linux",
      drizzleExecutable: "drizzle-kit",
      env: {},
      log,
      errorLog,
    });

    child.emit("close", 23);

    await expect(exitCodePromise).resolves.toBe(23);
    expect(errorLog).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("drizzle-kit");
    expect(spawnImpl.mock.calls[0]?.[1]).toEqual(["migrate"]);
  });

  it("uses close event code when process exits without error", async () => {
    const { runDrizzleMigrate } = await loadModule();

    const child = new EventEmitter();
    const spawnImpl = vi.fn<(...args: unknown[]) => EventEmitter>(() => child);

    const exitCodePromise = runDrizzleMigrate("postgresql://user:pass@localhost:5432/fullstack_nextjs", {
      mode: "dev",
      spawnImpl,
      platform: "linux",
      drizzleExecutable: "drizzle-kit",
      env: {},
      log: vi.fn(),
      errorLog: vi.fn(),
    });

    child.emit("close", 0);
    await expect(exitCodePromise).resolves.toBe(0);
  });
});

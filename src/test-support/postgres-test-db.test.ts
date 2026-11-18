import { describe, expect, it } from "vitest";

import { isSafeTestDatabaseName, parseAndValidateTestDatabaseUrl } from "@/src/test-support/postgres-test-db";

describe("postgres test database guards", () => {
  it("accepts valid test database naming tokens", () => {
    expect(isSafeTestDatabaseName("fullstack_nextjs_test")).toBe(true);
    expect(isSafeTestDatabaseName("app-testing")).toBe(true);
    expect(isSafeTestDatabaseName("e2e")).toBe(true);
    expect(isSafeTestDatabaseName("project_ci")).toBe(true);
  });

  it("rejects accidental substring matches that are not full tokens", () => {
    expect(isSafeTestDatabaseName("contest")).toBe(false);
    expect(isSafeTestDatabaseName("latest")).toBe(false);
    expect(isSafeTestDatabaseName("circuit")).toBe(false);
  });

  it("keeps URL-level validation aligned with token policy", () => {
    expect(() => parseAndValidateTestDatabaseUrl("postgresql://user:pass@localhost:5433/fullstack_nextjs_test")).not.toThrow();
    expect(() => parseAndValidateTestDatabaseUrl("postgresql://user:pass@localhost:5433/contest")).toThrowError(
      "must include test/testing/e2e/ci as a full token",
    );
  });
});

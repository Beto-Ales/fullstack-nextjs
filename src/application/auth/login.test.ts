import { getRounds } from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loginAction } from "@/app/login/actions";
import {
  AUTH_SERVICE_UNAVAILABLE_MESSAGE, INVALID_CREDENTIALS_MESSAGE, TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/src/application/auth/errors";
import { authenticateUser } from "@/src/application/auth/auth-service";
import { BCRYPT_COST } from "@/src/domain/auth/password-policy";
import { DUMMY_PASSWORD_HASH } from "@/src/infrastructure/security/password";

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  release: vi.fn(),
  findUser: vi.fn(),
  createSession: vi.fn(),
  verifyPassword: vi.fn(),
  headers: vi.fn(),
  setCookie: vi.fn(),
  redirect: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/src/interfaces/auth/session", () => ({ setSessionCookie: mocks.setCookie }));
vi.mock("@/src/infrastructure/db/client", () => ({ db: {} }));
vi.mock("@/src/infrastructure/logger", () => ({ logger: { error: mocks.logError } }));
vi.mock("@/src/infrastructure/security/auth-rate-limit", () => ({
  reserveLoginAttempt: mocks.consume, releaseLoginIdentityAttempt: mocks.release,
}));
vi.mock("@/src/infrastructure/auth/auth-repository", () => ({
  findUserByNormalizedEmail: mocks.findUser,
  createSession: mocks.createSession,
}));
vi.mock("@/src/infrastructure/security/password", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/src/infrastructure/security/password")>(),
  verifyPassword: mocks.verifyPassword,
}));

const credentials = { email: " Student@Example.com ", password: "synthetic-password" };
const activeUser = { id: "user-id", email: "student@example.com", status: "ACTIVE", role: "STUDENT", passwordHash: "stored-hash" };
const reservation = { key: "derived-key", expiresAtEpoch: "1795377355.123456" };

function makeForm(input = credentials) {
  const form = new FormData();
  form.set("email", input.email);
  form.set("password", input.password);
  return form;
}

describe("login", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
    mocks.consume.mockResolvedValue(reservation);
    mocks.findUser.mockResolvedValue(activeUser);
  });

  it("returns the same response for wrong passwords, unknown or disabled users, and invalid fields", async () => {
    for (const user of [activeUser, null, { ...activeUser, status: "DISABLED" }]) {
      mocks.findUser.mockResolvedValue(user);
      await expect(loginAction({}, makeForm())).resolves.toEqual({ error: INVALID_CREDENTIALS_MESSAGE });
    }
    await expect(loginAction({}, makeForm({ ...credentials, email: "bad" })))
      .resolves.toEqual({ error: INVALID_CREDENTIALS_MESSAGE });
    expect(mocks.consume).toHaveBeenCalledTimes(3);
    expect(mocks.verifyPassword.mock.calls).toEqual([
      [credentials.password, activeUser.passwordHash],
      [credentials.password, DUMMY_PASSWORD_HASH],
      [credentials.password, DUMMY_PASSWORD_HASH],
    ]);
    expect(getRounds(DUMMY_PASSWORD_HASH)).toBe(BCRYPT_COST);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it.each([null, { ...activeUser, status: "DISABLED" }])("rejects even a matching dummy comparison", async (user) => {
    mocks.findUser.mockResolvedValue(user);
    mocks.verifyPassword.mockResolvedValue(true);

    await expect(authenticateUser(credentials)).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("uses the same normalized identity despite variations in request headers", async () => {
    mocks.consume.mockResolvedValue(null);
    for (const source of ["192.0.2.10", "198.51.100.37"]) {
      mocks.headers.mockResolvedValue(new Headers({
        "x-forwarded-for": source, "x-real-ip": source, forwarded: `for=${source}`, "user-agent": `agent-${source}`,
      }));
      await expect(loginAction({}, makeForm())).resolves.toEqual({ error: TOO_MANY_ATTEMPTS_MESSAGE });
    }
    expect(mocks.consume.mock.calls).toEqual([[{}, activeUser.email], [{}, activeUser.email]]);
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("fails closed and logs safe metadata if the limiter throws", async () => {
    mocks.consume.mockRejectedValue(new Error("private connection details"));
    await expect(loginAction({}, makeForm())).resolves.toEqual({ error: AUTH_SERVICE_UNAVAILABLE_MESSAGE });
    expect(mocks.logError).toHaveBeenCalledWith("Login action failed unexpectedly.", {
      location: "app/login/actions.ts", type: "Error",
    });
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("returns a temporary error before session issuance if an identity reservation cannot be released", async () => {
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.release.mockRejectedValue(new Error("private connection details"));

    await expect(loginAction({}, makeForm())).resolves.toEqual({ error: AUTH_SERVICE_UNAVAILABLE_MESSAGE });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it("still returns a temporary error when the logger cannot read its configuration", async () => {
    mocks.consume.mockRejectedValue(new Error("private connection details"));
    mocks.logError.mockImplementation(() => { throw new Error("private configuration details"); });
    const fallback = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(loginAction({}, makeForm())).resolves.toEqual({ error: AUTH_SERVICE_UNAVAILABLE_MESSAGE });
      expect(fallback).toHaveBeenCalledWith("Login action failed unexpectedly.");
    } finally {
      fallback.mockRestore();
    }
  });

  it("checks the live account before setting the cookie and redirecting a successful login", async () => {
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.createSession.mockResolvedValue(true);

    await loginAction({}, makeForm());

    expect(mocks.findUser).toHaveBeenCalledWith(activeUser.email);
    expect(mocks.release).toHaveBeenCalledWith({}, reservation);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: activeUser.id, tokenHash: expect.any(String), expiresAt: expect.any(Date) }),
      activeUser.passwordHash, activeUser.email,
    );
    expect(mocks.setCookie).toHaveBeenCalledWith(expect.any(String), expect.any(Date));
    expect(mocks.redirect).toHaveBeenCalledWith("/student");
  });
});

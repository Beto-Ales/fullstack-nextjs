import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { AuthServiceError, INVALID_CREDENTIALS_MESSAGE, TOO_MANY_ATTEMPTS_MESSAGE } from "@/src/application/auth/errors";
import { resolvePostLoginPath } from "@/src/application/auth/redirects";
import { changeStudentPasswordSchema, createStudentAccountSchema, createSuperAdminInputSchema, loginInputSchema } from "@/src/application/auth/schemas";
import { SESSION_DURATION_MS } from "@/src/domain/auth/session-policy";
import type { UserRole } from "@/src/domain/auth/roles";
import {
  createSession,
  deleteSessionByTokenHash,
  findUserByNormalizedEmail,
  findValidSessionByTokenHash,
} from "@/src/infrastructure/auth/auth-repository";
import { db } from "@/src/infrastructure/db/client";
import { sessions, studentProfiles, users } from "@/src/infrastructure/db/schema";
import { ApplicationError } from "@/src/infrastructure/errors";
import { releaseLoginIdentityAttempt, reserveLoginAttempt } from "@/src/infrastructure/security/auth-rate-limit";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "@/src/infrastructure/security/password";
import { createSessionToken, hashSessionToken } from "@/src/infrastructure/security/session-token";

type AuthenticateInput = {
  email: string;
  password: string;
  returnTo?: string;
  userAgent?: string;
};

export async function authenticateUser(input: AuthenticateInput): Promise<{
  userId: string;
  role: UserRole;
  email: string;
  sessionToken: string;
  sessionExpiresAt: Date;
  redirectTo: string;
}> {
  const parsed = loginInputSchema.safeParse({
    email: input.email,
    password: input.password,
    returnTo: input.returnTo,
  });

  if (!parsed.success) {
    throw new AuthServiceError("invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
  }

  const reservation = await reserveLoginAttempt(db, parsed.data.email);
  if (!reservation) {
    throw new AuthServiceError("too_many_attempts", TOO_MANY_ATTEMPTS_MESSAGE);
  }

  const user = await findUserByNormalizedEmail(parsed.data.email);
  const activeUser = user?.status === "ACTIVE" ? user : null;
  const passwordMatches = await verifyPassword(parsed.data.password, activeUser?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!activeUser || !passwordMatches) {
    throw new AuthServiceError("invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
  }

  await releaseLoginIdentityAttempt(db, reservation);
  const sessionToken = createSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  const created = await createSession({
    id: randomUUID(),
    userId: activeUser.id,
    tokenHash,
    expiresAt: sessionExpiresAt,
    userAgent: input.userAgent,
  }, activeUser.passwordHash, parsed.data.email);
  if (!created) {
    throw new AuthServiceError("invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
  }

  return {
    userId: activeUser.id,
    role: activeUser.role,
    email: activeUser.email,
    sessionToken,
    sessionExpiresAt,
    redirectTo: resolvePostLoginPath(activeUser.role, parsed.data.returnTo),
  };
}

export async function getAuthenticatedUserFromSessionToken(sessionToken: string) {
  const tokenHash = hashSessionToken(sessionToken);
  const session = await findValidSessionByTokenHash(tokenHash);
  if (!session || session.status !== "ACTIVE") {
    return null;
  }
  return {
    userId: session.userId,
    role: session.role,
    email: session.email,
    sessionId: session.sessionId,
    sessionExpiresAt: session.expiresAt,
  };
}

export async function revokeSession(sessionToken: string): Promise<void> {
  const tokenHash = hashSessionToken(sessionToken);
  await deleteSessionByTokenHash(tokenHash);
}

export async function createStudentAccount(actor: { role: UserRole }, input: unknown) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new ApplicationError("Solo la administración puede dar de alta a alumnos.", "forbidden", 403, true);
  }
  const { email, password, firstName, lastName } = createStudentAccountSchema.parse(input);
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({
      id: randomUUID(), email, emailNormalized: email, passwordHash, role: "STUDENT",
    }).onConflictDoNothing({ target: users.emailNormalized }).returning({ id: users.id });
    if (!user) {
      throw new ApplicationError("Ya existe una cuenta con ese email.", "email_exists", 409, true);
    }
    await tx.insert(studentProfiles).values({ id: randomUUID(), userId: user.id, firstName, lastName });
  });
}

export async function changeStudentPassword(actor: { userId: string; role: UserRole }, input: unknown) {
  if (actor.role !== "STUDENT") {
    throw new ApplicationError("Solo el alumno puede cambiar su propia contraseña desde el panel.", "forbidden", 403, true);
  }
  const { currentPassword, newPassword } = changeStudentPasswordSchema.parse(input);
  const activeStudent = and(eq(users.id, actor.userId), eq(users.role, "STUDENT"), eq(users.status, "ACTIVE"));
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(activeStudent);
  const invalidPassword = () => new ApplicationError("La contraseña actual no es correcta.", "invalid_current_password", 403, true);
  if (!user || !await verifyPassword(currentPassword, user.passwordHash)) {
    throw invalidPassword();
  }
  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw new ApplicationError("Elige una contraseña distinta de la actual.", "unchanged_password", 400, true);
  }

  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    const [updated] = await tx.update(users).set({ passwordHash, updatedAt: new Date() })
      .where(and(activeStudent, eq(users.passwordHash, user.passwordHash))).returning({ id: users.id });
    if (!updated) throw invalidPassword();
    await tx.delete(sessions).where(eq(sessions.userId, updated.id));
  });
}

export async function createInitialSuperAdmin(input: { email: string; password: string }): Promise<{
  created: boolean;
  reason?: "super_admin_exists" | "email_exists";
}> {
  const parsed = createSuperAdminInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid super admin input.");
  }

  return db.transaction(async (tx) => {
    const [firstSuperAdmin] = await tx.select({ id: users.id }).from(users).where(eq(users.role, "SUPER_ADMIN")).limit(1);
    if (firstSuperAdmin) {
      return { created: false, reason: "super_admin_exists" as const };
    }

    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailNormalized, parsed.data.email))
      .limit(1);

    if (existingUser) {
      return { created: false, reason: "email_exists" as const };
    }

    const passwordHash = await hashPassword(parsed.data.password);
    await tx.insert(users).values({
      id: randomUUID(),
      email: parsed.data.email,
      emailNormalized: parsed.data.email,
      passwordHash,
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

    return { created: true };
  });
}

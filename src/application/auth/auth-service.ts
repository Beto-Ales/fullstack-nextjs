import "server-only";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { AuthServiceError, INVALID_CREDENTIALS_MESSAGE, TOO_MANY_ATTEMPTS_MESSAGE } from "@/src/application/auth/errors";
import { resolvePostLoginPath } from "@/src/application/auth/redirects";
import { createSuperAdminInputSchema, loginInputSchema } from "@/src/application/auth/schemas";
import { SESSION_DURATION_MS } from "@/src/domain/auth/session-policy";
import type { UserRole } from "@/src/domain/auth/roles";
import {
  createSession,
  deleteSessionByTokenHash,
  findUserByNormalizedEmail,
  findValidSessionByTokenHash,
} from "@/src/infrastructure/auth/auth-repository";
import { db } from "@/src/infrastructure/db/client";
import { users } from "@/src/infrastructure/db/schema";
import { hashPassword, verifyPassword } from "@/src/infrastructure/security/password";
import {
  buildRateLimitKey,
  clearLoginFailures,
  isLoginBlocked,
  registerLoginFailure,
} from "@/src/infrastructure/security/auth-rate-limit";
import { createSessionToken, hashSessionToken } from "@/src/infrastructure/security/session-token";

type AuthenticateInput = {
  email: string;
  password: string;
  returnTo?: string;
  sourceKey: string;
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
    throw new Error(INVALID_CREDENTIALS_MESSAGE);
  }

  const rateLimitKey = buildRateLimitKey(parsed.data.email, input.sourceKey);
  if (isLoginBlocked(rateLimitKey)) {
    throw new AuthServiceError("too_many_attempts", TOO_MANY_ATTEMPTS_MESSAGE);
  }

  const user = await findUserByNormalizedEmail(parsed.data.email);
  if (!user || user.status !== "ACTIVE") {
    registerLoginFailure(rateLimitKey);
    throw new AuthServiceError("invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
  }

  const passwordMatches = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!passwordMatches) {
    registerLoginFailure(rateLimitKey);
    throw new AuthServiceError("invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
  }

  clearLoginFailures(rateLimitKey);

  const sessionToken = createSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await createSession({
    id: randomUUID(),
    userId: user.id,
    tokenHash,
    expiresAt: sessionExpiresAt,
    userAgent: input.userAgent,
  });

  return {
    userId: user.id,
    role: user.role,
    email: user.email,
    sessionToken,
    sessionExpiresAt,
    redirectTo: resolvePostLoginPath(user.role, parsed.data.returnTo),
  };
}

export async function getAuthenticatedUserFromSessionToken(sessionToken: string) {
  const tokenHash = hashSessionToken(sessionToken);
  const session = await findValidSessionByTokenHash(tokenHash);
  if (!session) {
    return null;
  }
  if (session.status !== "ACTIVE") {
    await deleteSessionByTokenHash(tokenHash);
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

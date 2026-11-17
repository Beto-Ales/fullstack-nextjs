import "server-only";

import { and, eq, gt } from "drizzle-orm";

import { db } from "@/src/infrastructure/db/client";
import { sessions, users } from "@/src/infrastructure/db/schema";

export async function findUserByNormalizedEmail(emailNormalized: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      emailNormalized: users.emailNormalized,
      passwordHash: users.passwordHash,
      role: users.role,
      status: users.status,
      deactivatedAt: users.deactivatedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.emailNormalized, emailNormalized))
    .limit(1);

  return user ?? null;
}

export async function findUserById(userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      emailNormalized: users.emailNormalized,
      role: users.role,
      status: users.status,
      deactivatedAt: users.deactivatedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

export async function createSession(input: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent?: string;
}) {
  await db.insert(sessions).values({
    id: input.id,
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    userAgent: input.userAgent,
  });
}

export async function findValidSessionByTokenHash(tokenHash: string) {
  const [result] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      role: users.role,
      status: users.status,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  return result ?? null;
}

export async function deleteSessionByTokenHash(tokenHash: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

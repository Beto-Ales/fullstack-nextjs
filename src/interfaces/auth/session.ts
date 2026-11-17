import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { hasRequiredRole } from "@/src/domain/auth/authorization";
import { getRoleHomePath, type UserRole } from "@/src/domain/auth/roles";
import { getSessionCookieName } from "@/src/domain/auth/session-policy";
import { getEnvironment } from "@/src/infrastructure/env";

function readSessionCookieName(): string {
  return getSessionCookieName(getEnvironment().NODE_ENV);
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const cookieStore = await cookies();
  const { NODE_ENV } = getEnvironment();
  cookieStore.set(readSessionCookieName(), token, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(readSessionCookieName());
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(readSessionCookieName())?.value;
  if (!token) {
    return null;
  }

  const { getAuthenticatedUserFromSessionToken } = await import("@/src/application/auth/auth-service");
  return getAuthenticatedUserFromSessionToken(token);
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export async function requireRole(requiredRole: UserRole) {
  const user = await requireUser();
  if (!hasRequiredRole(user.role, requiredRole)) {
    redirect(getRoleHomePath(user.role));
  }
  return user;
}

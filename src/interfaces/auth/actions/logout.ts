"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getSessionCookieName } from "@/src/domain/auth/session-policy";
import { getEnvironment } from "@/src/infrastructure/env";
import { clearSessionCookie } from "@/src/interfaces/auth/session";

export async function logoutAction() {
  const cookieStore = await cookies();
  const sessionCookieName = getSessionCookieName(getEnvironment().NODE_ENV);
  const currentToken = cookieStore.get(sessionCookieName)?.value;

  if (currentToken) {
    const { revokeSession } = await import("@/src/application/auth/auth-service");
    await revokeSession(currentToken);
  }

  await clearSessionCookie();
  redirect("/login");
}

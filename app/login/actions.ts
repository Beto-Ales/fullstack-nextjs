"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  AUTH_SERVICE_UNAVAILABLE_MESSAGE,
  AuthServiceError,
  INVALID_CREDENTIALS_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from "@/src/application/auth/errors";
import { logger } from "@/src/infrastructure/logger";
import { clearSessionCookie, setSessionCookie } from "@/src/interfaces/auth/session";

export type LoginActionState = {
  error?: string;
};

function getRequestSourceKey(forwardedFor: string | null, userAgent: string | null): string {
  const ip = forwardedFor?.split(",")[0]?.trim() || "unknown-ip";
  const ua = userAgent || "unknown-ua";
  return `${ip}:${ua}`;
}

export async function loginAction(_prevState: LoginActionState, formData: FormData): Promise<LoginActionState> {
  const email = formData.get("email");
  const password = formData.get("password");
  const returnTo = formData.get("returnTo");

  if (typeof email !== "string" || typeof password !== "string") {
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent");
  const forwardedFor = headerStore.get("x-forwarded-for");

  try {
    const { authenticateUser } = await import("@/src/application/auth/auth-service");
    const authResult = await authenticateUser({
      email,
      password,
      returnTo: typeof returnTo === "string" ? returnTo : undefined,
      sourceKey: getRequestSourceKey(forwardedFor, userAgent),
      userAgent: userAgent ?? undefined,
    });

    await setSessionCookie(authResult.sessionToken, authResult.sessionExpiresAt);
    redirect(authResult.redirectTo);
  } catch (error) {
    await clearSessionCookie();
    if (error instanceof AuthServiceError) {
      if (error.code === "too_many_attempts") {
        return { error: TOO_MANY_ATTEMPTS_MESSAGE };
      }
      return { error: INVALID_CREDENTIALS_MESSAGE };
    }
    logger.error("Login action failed unexpectedly.", {
      location: "app/login/actions.ts",
      type: error instanceof Error ? error.name : "unknown",
    });
    return { error: AUTH_SERVICE_UNAVAILABLE_MESSAGE };
  }
}

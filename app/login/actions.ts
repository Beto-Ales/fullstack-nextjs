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
import { setSessionCookie } from "@/src/interfaces/auth/session";

export type LoginActionState = {
  error?: string;
};

export async function loginAction(_prevState: LoginActionState, formData: FormData): Promise<LoginActionState> {
  const email = formData.get("email");
  const password = formData.get("password");
  const returnTo = formData.get("returnTo");

  if (typeof email !== "string" || typeof password !== "string") {
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  let redirectTo: string;
  try {
    const userAgent = (await headers()).get("user-agent");
    const { authenticateUser } = await import("@/src/application/auth/auth-service");
    const authResult = await authenticateUser({
      email,
      password,
      returnTo: typeof returnTo === "string" ? returnTo : undefined,
      userAgent: userAgent ?? undefined,
    });

    await setSessionCookie(authResult.sessionToken, authResult.sessionExpiresAt);
    redirectTo = authResult.redirectTo;
  } catch (error) {
    if (error instanceof AuthServiceError) {
      if (error.code === "too_many_attempts") {
        return { error: TOO_MANY_ATTEMPTS_MESSAGE };
      }
      return { error: INVALID_CREDENTIALS_MESSAGE };
    }
    try {
      logger.error("Login action failed unexpectedly.", {
        location: "app/login/actions.ts",
        type: error instanceof Error ? error.name : "unknown",
      });
    } catch {
      console.error("Login action failed unexpectedly.");
    }
    return { error: AUTH_SERVICE_UNAVAILABLE_MESSAGE };
  }

  redirect(redirectTo);
}

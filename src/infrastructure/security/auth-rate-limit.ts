import "server-only";

import { getEnvironment } from "@/src/infrastructure/env";

type RateLimitEntry = {
  attempts: number;
  firstFailureAt: number;
  blockedUntil?: number;
};

const authAttempts = new Map<string, RateLimitEntry>();

function now(): number {
  return Date.now();
}

export function buildRateLimitKey(emailNormalized: string, sourceKey: string): string {
  return `${emailNormalized}:${sourceKey}`;
}

export function isLoginBlocked(rateLimitKey: string): boolean {
  const entry = authAttempts.get(rateLimitKey);
  if (!entry) {
    return false;
  }
  if (!entry.blockedUntil) {
    return false;
  }
  if (entry.blockedUntil <= now()) {
    authAttempts.delete(rateLimitKey);
    return false;
  }
  return true;
}

export function registerLoginFailure(rateLimitKey: string): void {
  const currentTime = now();
  const {
    AUTH_RATE_LIMIT_MAX_ATTEMPTS: maxAttempts,
    AUTH_RATE_LIMIT_WINDOW_MINUTES: windowMinutes,
  } = getEnvironment();
  const windowMs = windowMinutes * 60 * 1000;

  const existing = authAttempts.get(rateLimitKey);
  if (!existing) {
    authAttempts.set(rateLimitKey, { attempts: 1, firstFailureAt: currentTime });
    return;
  }

  const outsideWindow = currentTime - existing.firstFailureAt > windowMs;
  if (outsideWindow) {
    authAttempts.set(rateLimitKey, { attempts: 1, firstFailureAt: currentTime });
    return;
  }

  const attempts = existing.attempts + 1;
  if (attempts >= maxAttempts) {
    authAttempts.set(rateLimitKey, {
      attempts,
      firstFailureAt: existing.firstFailureAt,
      blockedUntil: currentTime + windowMs,
    });
    return;
  }

  authAttempts.set(rateLimitKey, { ...existing, attempts });
}

export function clearLoginFailures(rateLimitKey: string): void {
  authAttempts.delete(rateLimitKey);
}


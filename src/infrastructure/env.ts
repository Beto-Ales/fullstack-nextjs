import "server-only";

import { z } from "zod";

import { CENTER_TIME_ZONE } from "@/src/domain/time/timezone";

const logLevels = ["debug", "info", "warn", "error"] as const;

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required.")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must start with postgres:// or postgresql://",
    ),
  APP_TIME_ZONE: z.literal(CENTER_TIME_ZONE).default(CENTER_TIME_ZONE),
  LOG_LEVEL: z.enum(logLevels).default("info"),
});

export const LOGIN_GLOBAL_MAX_ATTEMPTS = 600;

const loginRateLimitSchema = z.object({
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  AUTH_RATE_LIMIT_HMAC_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
});

export function parseLoginRateLimitConfig(rawEnvironment: Record<string, string | undefined>) {
  return loginRateLimitSchema.parse(rawEnvironment);
}

export type RuntimeEnvironment = z.infer<typeof environmentSchema>;

export function parseEnvironment(rawEnvironment: Record<string, string | undefined>): RuntimeEnvironment {
  return environmentSchema.parse(rawEnvironment);
}

let cachedEnvironment: RuntimeEnvironment | undefined;

export function getEnvironment(): RuntimeEnvironment {
  if (!cachedEnvironment) {
    cachedEnvironment = parseEnvironment(process.env);
  }
  return cachedEnvironment;
}

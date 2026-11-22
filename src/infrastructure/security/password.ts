import "server-only";

import bcrypt from "bcrypt";

import { BCRYPT_COST } from "@/src/domain/auth/password-policy";

// Generated at the configured bcrypt cost from a random value that was discarded.
export const DUMMY_PASSWORD_HASH = "$2b$12$MkLL2gc6ZPBNRyg632W7LuU8dkDjCdB4EPmk.ZBQdztRByq9q/E5i";

export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, BCRYPT_COST);
}

export async function verifyPassword(plainPassword: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, passwordHash);
}


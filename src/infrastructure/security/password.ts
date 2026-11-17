import "server-only";

import bcrypt from "bcrypt";

import { BCRYPT_COST } from "@/src/domain/auth/password-policy";

export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, BCRYPT_COST);
}

export async function verifyPassword(plainPassword: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, passwordHash);
}


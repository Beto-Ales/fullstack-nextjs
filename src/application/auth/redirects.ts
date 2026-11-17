import { getRoleHomePath, type UserRole } from "@/src/domain/auth/roles";

export function sanitizeReturnPath(returnTo: string | undefined): string | null {
  if (!returnTo) {
    return null;
  }
  if (!returnTo.startsWith("/")) {
    return null;
  }
  if (returnTo.startsWith("//")) {
    return null;
  }
  return returnTo;
}

export function resolvePostLoginPath(role: UserRole, returnTo: string | undefined): string {
  const safeReturnPath = sanitizeReturnPath(returnTo);
  const defaultPath = getRoleHomePath(role);
  if (!safeReturnPath) {
    return defaultPath;
  }
  if (role === "SUPER_ADMIN") {
    if (safeReturnPath.startsWith("/admin")) {
      return safeReturnPath;
    }
    return defaultPath;
  }
  if (safeReturnPath.startsWith("/student")) {
    return safeReturnPath;
  }
  return defaultPath;
}


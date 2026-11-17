import type { UserRole } from "@/src/domain/auth/roles";

export function hasRequiredRole(userRole: UserRole, requiredRole: UserRole): boolean {
  return userRole === requiredRole;
}


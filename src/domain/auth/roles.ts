export const USER_ROLES = ["STUDENT", "SUPER_ADMIN"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const ACCOUNT_STATUSES = ["ACTIVE", "DISABLED"] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function getRoleHomePath(role: UserRole): string {
  if (role === "SUPER_ADMIN") {
    return "/admin";
  }
  return "/student";
}


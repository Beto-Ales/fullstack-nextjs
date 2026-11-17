import type { ReactNode } from "react";

import { requireRole } from "@/src/interfaces/auth/session";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireRole("SUPER_ADMIN");
  return <>{children}</>;
}


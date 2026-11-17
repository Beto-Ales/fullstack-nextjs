import type { ReactNode } from "react";

import { requireRole } from "@/src/interfaces/auth/session";

export default async function StudentLayout({ children }: { children: ReactNode }) {
  await requireRole("STUDENT");
  return <>{children}</>;
}


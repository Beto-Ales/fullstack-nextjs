import { redirect } from "next/navigation";

import { sanitizeReturnPath } from "@/src/application/auth/redirects";
import { getRoleHomePath } from "@/src/domain/auth/roles";
import { getCurrentUser } from "@/src/interfaces/auth/session";
import { LoginForm } from "@/app/login/login-form";

type LoginPageProps = {
  searchParams: Promise<{
    returnTo?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const user = await getCurrentUser();
  if (user) {
    redirect(getRoleHomePath(user.role));
  }

  const params = await searchParams;
  const returnTo = sanitizeReturnPath(params.returnTo);

  return (
    <main>
      <h1>Iniciar sesión</h1>
      <p>Accede con tu email y contraseña.</p>
      <LoginForm returnTo={returnTo ?? undefined} />
    </main>
  );
}


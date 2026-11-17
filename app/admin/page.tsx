import { logoutAction } from "@/src/interfaces/auth/actions/logout";
import { requireRole } from "@/src/interfaces/auth/session";

export default async function AdminHomePage() {
  const user = await requireRole("SUPER_ADMIN");

  return (
    <main>
      <h1>Área de administración</h1>
      <p>Sesión iniciada como: {user.email}</p>
      <form action={logoutAction}>
        <button type="submit">Cerrar sesión</button>
      </form>
    </main>
  );
}


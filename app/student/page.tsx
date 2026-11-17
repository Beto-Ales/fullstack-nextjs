import { logoutAction } from "@/src/interfaces/auth/actions/logout";
import { requireRole } from "@/src/interfaces/auth/session";

export default async function StudentHomePage() {
  const user = await requireRole("STUDENT");

  return (
    <main>
      <h1>Área de alumno</h1>
      <p>Sesión iniciada como: {user.email}</p>
      <form action={logoutAction}>
        <button type="submit">Cerrar sesión</button>
      </form>
    </main>
  );
}


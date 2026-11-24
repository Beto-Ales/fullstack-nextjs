import Link from "next/link";

export default function Home() {
  return (
    <main id="contenido-principal" tabIndex={-1}>
      <div className="mx-auto my-8 max-w-2xl rounded-lg bg-[var(--surface)] p-6 sm:my-16 sm:p-10">
        <h1>Art Workshop Copenhagen</h1>
        <p className="mt-3">Gestión de clases, reservas y alumnos del taller.</p>
        <Link href="/login" className="mt-4 inline-flex min-h-11 items-center font-semibold">
          Iniciar sesión
        </Link>
      </div>
    </main>
  );
}

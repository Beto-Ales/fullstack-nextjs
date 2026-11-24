import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Art Workshop Copenhagen",
  description: "Gestión de clases, reservas y alumnos del taller.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="es">
      <body>
        <a href="#contenido-principal" className="skip-link">Saltar al contenido principal</a>
        {children}
      </body>
    </html>
  )
}

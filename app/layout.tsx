import "./globals.css";

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

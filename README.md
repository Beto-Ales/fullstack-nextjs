# Fullstack Next.js — Fundaciones técnicas

Base técnica inicial para una aplicación de gestión de clases y alumnos con Next.js App Router, TypeScript estricto y PostgreSQL + Drizzle.

> Estado funcional: incluye identidad y control de acceso base (login, sesiones y guards por rol), pero aún no incluye reservas, asistencia, cancelaciones, créditos ni recuperaciones.
> La especificación funcional consolidada (`PROJECT_SPEC.md`) sigue pendiente de incorporarse al repositorio.

## Requisitos

- Node.js 20.9+ (requisito de Next.js 16)
- npm 10+
- PostgreSQL 15+ (recomendado para entorno local)

## Primer arranque

1. Instala dependencias:

```bash
npm install
```

2. Crea tu entorno local:

```bash
cp .env.example .env
```

En PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Genera migraciones desde el esquema actual:

```bash
npm run db:generate
```

4. Aplica migraciones:

```bash
npm run db:migrate
```

5. Arranca la app:

```bash
npm run dev
```

## Scripts disponibles

- `npm run dev`: arranque en desarrollo.
- `npm run build`: build de producción.
- `npm run start`: ejecutar build de producción.
- `npm run lint`: lint de todo el proyecto.
- `npm run typecheck`: comprobación TypeScript sin emitir.
- `npm run test`: tests unitarios/integración con Vitest.
- `npm run test:watch`: Vitest en watch mode.
- `npm run test:e2e`: pruebas E2E con Playwright.
- `npm run db:generate`: generar migraciones Drizzle desde esquemas.
- `npm run db:migrate`: aplicar migraciones.
- `npm run db:studio`: abrir Drizzle Studio.
- `npm run admin:create-super-admin`: crear el primer `SUPER_ADMIN` (sin registro público).

## Documentación técnica

- [Arquitectura](./docs/architecture.md)
- [PostgreSQL + Drizzle](./docs/database-drizzle.md)
- [Autenticación y sesiones](./docs/authentication.md)
- [Fechas y zona horaria](./docs/datetime-timezone.md)
- [Testing](./docs/testing.md)

## Notas de seguridad

- Las credenciales se validan en servidor y no deben exponerse en variables `NEXT_PUBLIC_*`.
- No subir secretos al repositorio.
- Usar una base de datos de test separada para automatización.

## Variables de entorno

Ver [.env.example](./.env.example):

- `DATABASE_URL`: conexión PostgreSQL.
- `APP_TIME_ZONE`: zona del centro (`Europe/Copenhagen`).
- `LOG_LEVEL`: nivel de logs.
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`: intentos de login permitidos por ventana.
- `AUTH_RATE_LIMIT_WINDOW_MINUTES`: duración de la ventana de rate limiting.
- `SUPER_ADMIN_EMAIL` y `SUPER_ADMIN_PASSWORD`: variables temporales para el comando de creación inicial de superadmin.

# Fullstack Next.js — Fundaciones técnicas

Base técnica inicial para una aplicación de gestión de clases y alumnos con Next.js App Router, TypeScript estricto y PostgreSQL + Drizzle.

> Estado funcional. Incluye identidad, control de acceso, reservas, asistencia, cancelaciones, ledger de créditos, recuperaciones con consumo/devolución FIFO y normativa académica versionada.
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
npm run db:migrate:dev
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
- `npm run db:migrate:dev`: aplicar migraciones sobre la base de desarrollo (`DATABASE_URL`).
- `npm run db:migrate:test`: aplicar migraciones sobre la base de test (`TEST_DATABASE_URL`).
- `npm run db:migrate`: comando protegido; requiere seleccionar explícitamente `dev` o `test`.
- `npm run db:studio`: abrir Drizzle Studio.
- `npm run admin:create-super-admin`: crear el primer `SUPER_ADMIN` (sin registro público).
- `npm run academic:generate-sessions`: materializar/extender sesiones recurrentes (horizonte 3 meses).

## Documentación técnica

- [Arquitectura](./docs/architecture.md)
- [PostgreSQL + Drizzle](./docs/database-drizzle.md)
- [Autenticación y sesiones](./docs/authentication.md)
- [Modelo académico](./docs/academic-model.md)
- [Fechas y zona horaria](./docs/datetime-timezone.md)
- [Testing](./docs/testing.md)

## Notas de seguridad

- Las credenciales se validan en servidor y no deben exponerse en variables `NEXT_PUBLIC_*`.
- No subir secretos al repositorio.
- Usar una base de datos de test separada para automatización.

## Variables de entorno

Ver [.env.example](./.env.example):

- `DATABASE_URL`: conexión PostgreSQL.
- `TEST_DATABASE_URL`: conexión PostgreSQL exclusiva para integración (obligatoria para suites con DB real y nunca reemplazada silenciosamente por `DATABASE_URL`).
- `APP_TIME_ZONE`: zona del centro (`Europe/Copenhagen`).
- `LOG_LEVEL`: nivel de logs.
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`: intentos de login permitidos por ventana.
- `AUTH_RATE_LIMIT_WINDOW_MINUTES`: duración de la ventana de rate limiting.
- `SUPER_ADMIN_EMAIL` y `SUPER_ADMIN_PASSWORD`: variables temporales para el comando de creación inicial de superadmin.

## PostgreSQL local con Docker Compose (Windows 11 + PowerShell)

Se incluye [compose.yaml](./compose.yaml) con **dos contenedores PostgreSQL 15**:

- `postgres_dev` en `127.0.0.1:5432` para desarrollo.
- `postgres_test` en `127.0.0.1:5433` para integración.

La versión `postgres:15` se selecciona porque el proyecto exige PostgreSQL 15+ y esta base ya está alineada con los requisitos actuales del repositorio.

### Preparación de variables locales (no versionadas)

```powershell
Copy-Item .env.compose.example .env.compose.local
```

Editar `.env.compose.local` con credenciales locales.

### Levantar y detener servicios (sin borrar datos)

```powershell
docker compose --env-file .env.compose.local up -d
docker compose --env-file .env.compose.local ps
docker compose --env-file .env.compose.local down
```

### Comprobar healthchecks y logs

```powershell
docker compose --env-file .env.compose.local ps
docker inspect --format='{{json .State.Health}}' fullstack_nextjs_postgres_dev
docker inspect --format='{{json .State.Health}}' fullstack_nextjs_postgres_test
docker compose --env-file .env.compose.local logs postgres_dev
docker compose --env-file .env.compose.local logs postgres_test
```

### Borrado explícito de volúmenes (destructivo)

⚠️ **Solo cuando quieras eliminar completamente los datos locales**.

```powershell
docker compose --env-file .env.compose.local down --volumes
```

### Migraciones por base (PowerShell)

Los comandos de migración validan el entorno antes de ejecutar Drizzle:

- `db:migrate:dev` exige `DATABASE_URL` y rechaza destinos con nombre de base de test.
- `db:migrate:test` exige `TEST_DATABASE_URL`, exige nombre de base con token completo `test/testing/e2e/ci` (separadores `_` o `-`) y rechaza destinos equivalentes a `DATABASE_URL`.
- La comparación de equivalencia entre destinos usa identidad canónica (`host` normalizado + puerto efectivo + nombre de base), ignorando usuario, contraseña y query params.
- `db:migrate` sin entorno falla con error descriptivo.

PowerShell:

```powershell
$env:DATABASE_URL = "postgresql://<POSTGRES_DEV_USER>:<POSTGRES_DEV_PASSWORD>@localhost:5432/<POSTGRES_DEV_DB>"; npm run db:migrate:dev
$env:TEST_DATABASE_URL = "postgresql://<POSTGRES_TEST_USER>:<POSTGRES_TEST_PASSWORD>@localhost:5433/<POSTGRES_TEST_DB>"; npm run db:migrate:test
```

Cada comando muestra el destino (`host:port/base`) sin imprimir contraseñas.

### Tests de integración PostgreSQL

```powershell
$env:TEST_DATABASE_URL = "postgresql://<POSTGRES_TEST_USER>:<POSTGRES_TEST_PASSWORD>@localhost:5433/<POSTGRES_TEST_DB>"
npm run test -- src/application/academic/academic.integration.test.ts src/application/credits/credit-service.integration.test.ts src/application/recovery/recovery.integration.test.ts
```

### Validación operativa Compose (Fase 06.2)

- `docker compose --env-file .env.compose.local config` validado correctamente.
- Servicios operativos y saludables:
  - `fullstack_nextjs_postgres_dev` en `127.0.0.1:5432`
  - `fullstack_nextjs_postgres_test` en `127.0.0.1:5433`
- Volúmenes aislados:
  - `fullstack-nextjs_postgres_dev_data`
  - `fullstack-nextjs_postgres_test_data`
- Comprobaciones de lectura (`pg_isready` y `SELECT current_database()`) confirmaron separación entre desarrollo y test.
- En esta validación **no** se ejecutaron migraciones ni operaciones destructivas.

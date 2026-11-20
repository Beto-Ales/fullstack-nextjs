# PostgreSQL y Drizzle ORM

## Dependencias

- `drizzle-orm`
- `drizzle-kit`
- `pg`
- `@types/pg`

## Archivos clave

- `drizzle.config.ts`: configuración de Drizzle Kit.
- `src/infrastructure/db/client.ts`: pool singleton y cliente Drizzle.
- `src/infrastructure/db/config.ts`: configuración de pool.
- `src/infrastructure/db/schema/`: esquemas Drizzle.

## Convenciones

- Esquemas en `src/infrastructure/db/schema`.
- Migraciones en `drizzle/`.
- Timestamps persistidos con zona horaria (`timestamptz`).

## Esquema actual

- `app_metadata`: metadatos técnicos.
- `users`: identidad, rol y estado de cuenta.
- `sessions`: sesiones persistentes con hash de token.
- `student_profiles`: perfil académico de usuario `STUDENT`.
- `class_templates`: plantilla semanal recurrente.
- `class_sessions`: ocurrencias concretas de clase.
- `student_template_assignments`: horarios habituales por alumno.
- `class_reservations`: reservas por sesión y alumno.
- `session_capacity_blocks`: plazas bloqueadas por administración.
- `reservation_cancellations`: historial de cancelaciones con secuencia/elegibilidad.
- `reservation_attendance_records`: historial de asistencia/ausencia con correcciones.
- `credit_ledger_movements`: ledger inmutable de créditos (auto, manual, retirada y caducidad).
- `academic_regulations`: versiones publicadas de normativa, con vigencia única y auditoría de cambios.
- `class_session_edits`: ediciones de sesiones con la versión aplicada.

## Migración de normativa

`0006_academic_regulations` incorpora la versión inicial y las referencias de aplicación. El 20 de noviembre de 2026 se aplicó solo a PostgreSQL TEST mediante el flujo Drizzle del repositorio. Las referencias de operaciones previas se conservan vacías.

## Flujo de migraciones

1. Cambiar esquemas en `src/infrastructure/db/schema`.
2. Ejecutar:
   - `npm run db:generate`
   - `npm run db:migrate:dev` o `npm run db:migrate:test` según entorno.

### Reglas de seguridad para migraciones

- `drizzle.config.ts` exige `DATABASE_URL`; no existe fallback silencioso.
- `npm run db:migrate:dev`:
  - requiere `DATABASE_URL`,
  - rechaza destinos que parezcan base de test (`test/testing/e2e/ci`).
- `npm run db:migrate:test`:
  - requiere `TEST_DATABASE_URL`,
  - exige base con token completo de test (`test/testing/e2e/ci` separado por `_` o `-`),
  - rechaza destinos equivalentes a `DATABASE_URL` usando identidad canónica (`host` normalizado + puerto efectivo + base), ignorando usuario/contraseña/query params.
- `npm run db:migrate` sin `dev|test` falla con mensaje de uso.

## Entorno local

Configurar `DATABASE_URL` en `.env` usando `.env.example` como base.
Para pruebas de integración, usar también `TEST_DATABASE_URL` apuntando a una base separada y segura.

Ejemplo local:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/fullstack_nextjs
```

## Docker Compose local (Windows 11 / PowerShell)

El repositorio incluye [compose.yaml](../compose.yaml) con dos servicios:

- `postgres_dev` (desarrollo): `127.0.0.1:5432`
- `postgres_test` (integración): `127.0.0.1:5433`

Ambos usan imagen `postgres:15`, volúmenes independientes y healthchecks con `pg_isready`.

### Variables locales de Compose

1. Copiar archivo base:

```powershell
Copy-Item .env.compose.example .env.compose.local
```

2. Editar `.env.compose.local` con credenciales locales.

### Comandos operativos

```powershell
# Levantar
docker compose --env-file .env.compose.local up -d

# Estado
docker compose --env-file .env.compose.local ps

# Logs
docker compose --env-file .env.compose.local logs postgres_dev
docker compose --env-file .env.compose.local logs postgres_test

# Detener sin borrar volúmenes
docker compose --env-file .env.compose.local down
```

### Borrado explícito de datos (destructivo)

```powershell
docker compose --env-file .env.compose.local down --volumes
```

### Aplicar migraciones en cada base

Drizzle no aplica migraciones automáticamente al arrancar contenedores.

```powershell
# Base de desarrollo
$env:DATABASE_URL = "postgresql://<POSTGRES_DEV_USER>:<POSTGRES_DEV_PASSWORD>@localhost:5432/<POSTGRES_DEV_DB>"; npm run db:migrate:dev

# Base de pruebas
$env:TEST_DATABASE_URL = "postgresql://<POSTGRES_TEST_USER>:<POSTGRES_TEST_PASSWORD>@localhost:5433/<POSTGRES_TEST_DB>"; npm run db:migrate:test
```

Los comandos imprimen destino seleccionado (`host:port/base`) sin mostrar secretos.

## Validación operativa (Fase 06.2)

Resultado de validación local sin migraciones:

- `docker compose --env-file .env.compose.local config`: válido.
- Contenedores levantados con healthcheck `healthy`:
  - `fullstack_nextjs_postgres_dev`
  - `fullstack_nextjs_postgres_test`
- Puertos publicados:
  - `127.0.0.1:5432 -> postgres_dev`
  - `127.0.0.1:5433 -> postgres_test`
- Volúmenes distintos por servicio:
  - `fullstack-nextjs_postgres_dev_data`
  - `fullstack-nextjs_postgres_test_data`
- Consultas de solo lectura confirmaron bases distintas por entorno (`current_database()`).

## Estado de migraciones

- `0000_smiling_hobgoblin.sql`: infraestructura base inicial.
- `0001_melted_christian_walker.sql`: tablas de identidad y sesiones.
- `0002_soft_toad.sql`: modelo académico (plantillas, sesiones, perfiles, reservas y capacidad).
- `0003_orange_microbe.sql`: asistencia y cancelaciones.
- `0004_mean_lifeguard.sql`: ledger de créditos.
- `0005_odd_rachel_grey.sql`: soporte de recuperaciones (vínculos ledger↔reserva, flags de devolución y metadatos de cancelación).

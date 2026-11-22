# Fullstack Next.js — Fundaciones técnicas

Base técnica inicial para una aplicación de gestión de clases y alumnos con Next.js App Router, TypeScript estricto y PostgreSQL + Drizzle.

> Estado funcional. Incluye identidad, control de acceso, reservas, asistencia, cancelaciones, ledger de créditos, recuperaciones con consumo/devolución FIFO y normativa académica versionada.
> La planificación por fases y la especificación funcional están en [planificacion_general.md](./planificacion_general.md).

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
- `npm run test`: suite completa de Vitest con PostgreSQL desechable.
- `npm run test:watch`: unitarias de Vitest en modo observación.
- `npm run test:unit`: unitarias sin PostgreSQL ni Docker.
- `npm run test:e2e`: Chromium con PostgreSQL desechable.
- `npm run test:verify`: Vitest, Chromium y créditos pendientes con normativa sintética.
- `npm run db:generate`: generar migraciones Drizzle desde esquemas.
- `npm run db:migrate:dev`: aplicar migraciones sobre la base de desarrollo (`DATABASE_URL`).
- `npm run db:migrate:test`: verificar el journal en PostgreSQL desechable.
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
- `TEST_DATABASE_URL`: conexión generada por el aprovisionador para cada ejecución de pruebas con PostgreSQL.
- `APP_TIME_ZONE`: zona del centro (`Europe/Copenhagen`).
- `LOG_LEVEL`: nivel de logs.
- `AUTH_RATE_LIMIT_HMAC_KEY` es obligatorio para el login. Genera 32 bytes aleatorios en hexadecimal y suministra el valor por la configuración privada del servidor. Todas las instancias deben usar el mismo secreto. Para asignar uno al proceso local en PowerShell, usa `$env:AUTH_RATE_LIMIT_HMAC_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"` antes de arrancar Next.js.
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS` acepta de 1 a 100 oportunidades por correo. El valor predeterminado es 5. El presupuesto general es de 600.
- `AUTH_RATE_LIMIT_WINDOW_MINUTES` acepta de 1 a 60 minutos para ambos presupuestos. El valor predeterminado es 15. Comparte los valores entre instancias y prepara la migración 0014 antes de activar esta versión. [Política y rotación](./docs/authentication.md#limitación-de-intentos-de-login)
- `SUPER_ADMIN_EMAIL` y `SUPER_ADMIN_PASSWORD`: variables temporales para el comando de creación inicial de superadmin.

## PostgreSQL local con Docker Compose (Windows 11 + PowerShell)

Se incluye [compose.yaml](./compose.yaml) con **dos contenedores PostgreSQL 15**:

- `postgres_dev` en `127.0.0.1:5432` para desarrollo.
- `postgres_test` en `127.0.0.1:5433`, reservado para TEST persistente.

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

- `db:migrate:dev` exige la conexión autorizada en `DATABASE_URL` y rechaza nombres de bases de prueba.
- `db:migrate:test` crea y verifica una instancia desechable, aplica el journal y retira la instancia al finalizar.
- `db:migrate` exige el modo `dev` o `test`.

### Tests de integración PostgreSQL

Inicia Docker y prepara la imagen local `postgres:15`. Ejecuta `npm run test:integration` para las integraciones o `npm run test:verify` para la verificación completa. El aprovisionador no acepta una URL de TEST manual. [Comandos de pruebas](docs/testing.md#comandos-vigentes-desde-106)

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

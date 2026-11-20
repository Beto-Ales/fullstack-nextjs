# Testing

## Objetivo en esta fase

Dejar lista una infraestructura de pruebas segura y mantenible, sin tocar datos reales.

## Herramientas

- **Vitest**: unitarias/integración técnica.
- **Playwright**: pruebas e2e.

## Estructura

- Unitarias/integración: `src/**/*.test.ts`
- E2E: `tests/e2e/**/*.spec.ts`

## Comandos

- `npm run test`
- `npm run test:watch`
- `npm run test:e2e`
- `npx playwright install chromium` (instala navegador E2E cuando falte)

## Base de datos para pruebas

- No usar base de datos de producción.
- Las suites de integración PostgreSQL usan **exclusivamente** `TEST_DATABASE_URL`.
- Si `TEST_DATABASE_URL` no existe, esas suites se omiten.
- No hay fallback silencioso a `DATABASE_URL` en tests de integración.
- Se rechaza la ejecución si `TEST_DATABASE_URL` no parece una base de test segura:
  - protocolo `postgres://` o `postgresql://`,
  - host local (`localhost`, `127.0.0.1` o `::1`),
  - nombre de base con token completo `test`, `testing`, `e2e` o `ci` (separado por `_` o `-`).
- La limpieza destructiva (`TRUNCATE ... CASCADE`) verifica primero la base conectada.

## Alternativas de Docker para dev/test

### A) Dos contenedores independientes (implementada)

- `postgres_dev` y `postgres_test` en puertos distintos (`5432` y `5433`).
- Volúmenes separados.
- Credenciales separadas en `.env.compose.local`.
- Riesgo menor de limpieza accidental cruzada.

### B) Un contenedor con dos bases de datos aisladas (no implementada)

- Menor consumo de recursos.
- Mayor riesgo operativo: error de conexión/variable puede apuntar a DB equivocada en el mismo servidor.
- Menor separación de blast radius en operaciones destructivas de tests.

Se implementa A por seguridad operacional en el flujo de integración.

## Compose en PowerShell

```powershell
# Preparar variables locales no versionadas
Copy-Item .env.compose.example .env.compose.local

# Levantar servicios
docker compose --env-file .env.compose.local up -d

# Estado de servicios
docker compose --env-file .env.compose.local ps

# Healthchecks
docker inspect --format='{{json .State.Health}}' fullstack_nextjs_postgres_dev
docker inspect --format='{{json .State.Health}}' fullstack_nextjs_postgres_test

# Logs
docker compose --env-file .env.compose.local logs postgres_dev
docker compose --env-file .env.compose.local logs postgres_test

# Detener sin perder datos
docker compose --env-file .env.compose.local down
```

### Eliminación explícita de volúmenes (destructivo)

```powershell
docker compose --env-file .env.compose.local down --volumes
```

### Migraciones por entorno

```powershell
# Desarrollo
$env:DATABASE_URL = "postgresql://<POSTGRES_DEV_USER>:<POSTGRES_DEV_PASSWORD>@localhost:5432/<POSTGRES_DEV_DB>"; npm run db:migrate:dev

# Pruebas
$env:TEST_DATABASE_URL = "postgresql://<POSTGRES_TEST_USER>:<POSTGRES_TEST_PASSWORD>@localhost:5433/<POSTGRES_TEST_DB>"; npm run db:migrate:test
```

Reglas de seguridad de migración:

- `db:migrate:dev` no permite destinos con nombre de base de test.
- `db:migrate:test` exige base con token completo de test (`test/testing/e2e/ci`) y no permite destino equivalente a `DATABASE_URL` (comparación canónica de `host` + puerto efectivo + base).
- `db:migrate` requiere elegir entorno explícitamente (`dev` o `test`).

### Resultado operativo de infraestructura (Fase 06.2)

- Validación de Compose completada con `.env.compose.local` sin exponer secretos.
- Ambos PostgreSQL en ejecución con `healthy`.
- Confirmada separación de entorno:
  - puertos distintos (`5432` y `5433`),
  - bases distintas (`fullstack_nextjs` y `fullstack_nextjs_test`),
  - volúmenes persistentes independientes.
- No se ejecutaron migraciones ni operaciones destructivas durante esta validación.

### Ejecutar integración contra PostgreSQL de test

```powershell
$env:TEST_DATABASE_URL = "postgresql://<POSTGRES_TEST_USER>:<POSTGRES_TEST_PASSWORD>@localhost:5433/<POSTGRES_TEST_DB>"
npm run test -- src/application/academic/academic.integration.test.ts src/application/credits/credit-service.integration.test.ts src/application/recovery/recovery.integration.test.ts
```

## Cobertura de esta fase

Se incluyen pruebas de:

- Validación centralizada de entorno.
- Configuración de zona horaria.
- Configuración base de base de datos (pool).
- Normalización de email y validación de credenciales.
- Hash/compare de contraseñas (`bcrypt`).
- Generación y hash de tokens de sesión.
- Expiración de sesión y reglas de autorización por rol.
- Guards E2E de rutas protegidas y pantalla de login.
- Conversión local/UTC y casos de DST.
- Generación recurrente de sesiones (horizonte, vigencia e idempotencia).
- Cálculo de disponibilidad (capacidad, reservas y plazas bloqueadas).
- Asignación habitual con reserva automática de sesiones futuras respetando capacidad y duplicados.
- Reglas de cancelación, secuencias y elegibilidad de candidaturas.
- Cálculo de límites mensuales/caducidad de créditos y saldo derivado de ledger.
- Selección FIFO para consumo en recuperaciones (caducidad, creación, id estable).
- Reglas de devolución de recuperaciones según umbral de 7 días y caducidad del crédito origen.

## Integración con PostgreSQL de test

- Se añadió una suite de integración académica condicionada a `TEST_DATABASE_URL`.
- Si la variable no está definida, esas pruebas se omiten de forma segura.
- Se añadió una suite de integración de créditos condicionada a `TEST_DATABASE_URL`:
  - idempotencia automática por cancelación,
  - límite mensual bajo concurrencia,
  - concurrencia en retiradas,
  - rollback en retiradas fallidas.
- Se añadió una suite de integración de recuperaciones condicionada a `TEST_DATABASE_URL`:
  - reserva + consumo transaccional,
  - idempotencia de reserva sin doble consumo,
  - rollback de reserva si no existe crédito consumible,
  - capacidad/bloqueos bajo concurrencia (última plaza y último crédito),
  - selección FIFO por caducidad en consumo,
  - límite mensual de recuperaciones,
  - devolución con/sin restauración de saldo según caducidad,
  - cancelación tardía sin devolución,
  - cancelación idempotente sin doble devolución.

## E2E de créditos

- Se añadió `tests/e2e/credits.spec.ts`.
- Requiere usuarios de prueba explícitos:
  - `E2E_STUDENT_EMAIL` / `E2E_STUDENT_PASSWORD`
  - `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`
- Si faltan variables, los tests se marcan como omitidos.
- El spec también valida presencia de la sección de recuperaciones en área de alumno.

## Matriz de pruebas (Fase 06.2)

Estado:

- `implementada`: existe en el repositorio.
- `ejecutada correctamente`: se ejecutó en este entorno y pasó.
- `fallida`: se ejecutó y falló.
- `pendiente de infraestructura`: requiere PostgreSQL/credenciales no disponibles en este entorno.

| ID | Invariante | Tipo | Archivo | Estado real | Comando |
|---|---|---|---|---|---|
| REC-CONC-001 | Reserva concurrente de última plaza: solo una operación confirma | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REC-CONC-002 | Consumo concurrente del último crédito: solo un consumo | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REC-IDEMP-001 | Idempotencia de consumo por reserva repetida | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REC-IDEMP-002 | Idempotencia de devolución en cancelación repetida | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REC-RB-001 | Rollback completo si falla consumo al reservar | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REC-FIFO-001 | Selección FIFO por caducidad (y desempates en unit tests de FIFO) | Integración + Unitaria | `src/application/recovery/recovery.integration.test.ts`, `src/application/credits/credit-fifo.test.ts` | Unitaria ejecutada correctamente / Integración pendiente de infraestructura | `npm run test -- src/application/credits/credit-fifo.test.ts src/application/recovery/recovery.integration.test.ts` |
| REC-LIMIT-001 | Límite mensual de recuperaciones | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REPROG-001 | Reprogramación entre meses recalcula `local_date` y cómputo mensual | Integración | `src/application/academic/academic.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/academic/academic.integration.test.ts` |
| REPROG-002 | Reprogramación rechazada si supera límite mensual | Integración | `src/application/academic/academic.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/academic/academic.integration.test.ts` |
| REC-CANCEL-001 | Cancelación anticipada (>=7 días) devuelve crédito según vigencia | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REC-CANCEL-002 | Cancelación tardía (<7 días) no devuelve crédito | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| REC-EXPIRED-001 | Devolución con crédito caducado es auditable y no restaura saldo | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| ADMIN-CANCEL-001 | Cancelación administrativa con múltiples recuperaciones, enlaces correctos consumo↔devolución | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| ADMIN-CANCEL-002 | Reintento de cancelación administrativa no duplica devoluciones | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| ADMIN-CANCEL-003 | Atomicidad: fallo intermedio revierte cancelación de sesión/devoluciones | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| ATTEND-001 | Corrección de asistencia mantiene trazabilidad superseded | Unitaria/Integración de flujo | `src/domain/academic/cancellation-rules.test.ts` + servicios académicos | Ejecutada correctamente (parte unitaria) / Integración pendiente de infraestructura | `npm run test -- src/domain/academic/cancellation-rules.test.ts src/application/academic/academic.integration.test.ts` |
| ABSENCE-001 | Detección de ausencias idempotente y sin dependencia UUID extension | Integración | `src/application/academic/academic.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/academic/academic.integration.test.ts` |
| HABITUAL-001 | Asignación habitual reserva sesiones futuras, evita duplicados y respeta capacidad | Integración | `src/application/academic/habitual-assignment.integration.test.ts` | Ejecutada correctamente | `npm run test -- src/application/academic/habitual-assignment.integration.test.ts` |
| LEDGER-INT-001 | Integridad ledger: detección de consumos/devoluciones huérfanos y auditoría manual incompleta | Integración | `src/application/credits/credit-service.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/credits/credit-service.integration.test.ts` |
| LOCK-CROSS-001 | Cruce reserva de recuperación vs cancelación administrativa sin estado imposible | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| E2E-AUTH-001 | Guardas de autenticación y rutas protegidas | E2E | `tests/e2e/auth-guards.spec.ts` | Ejecutada correctamente | `npm run test:e2e` |
| E2E-BASE-001 | Carga página inicial | E2E | `tests/e2e/home.spec.ts` | Ejecutada correctamente | `npm run test:e2e` |
| E2E-CRED-001 | Flujos E2E de créditos/recuperaciones UI | E2E | `tests/e2e/credits.spec.ts` | Pendiente de infraestructura (credenciales E2E no definidas) | `E2E_STUDENT_EMAIL=... E2E_STUDENT_PASSWORD=... E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... npm run test:e2e` |

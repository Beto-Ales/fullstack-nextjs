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
- Reglas de devolución de recuperaciones según la antelación vigente y la caducidad original del crédito.
- Selección, autorización, publicación y auditoría de versiones de normativa académica.

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

### Verificación de normativa (20 de noviembre de 2026)

- `0006_academic_regulations` se aplicó mediante el flujo Drizzle de TEST. Las suites que limpian tablas se ejecutaron en una base temporal del servidor TEST.
- `npm run test -- --configLoader runner --no-file-parallelism`. Aprobadas 86 pruebas en 24 archivos, incluidas las suites académicas, de créditos, de recuperaciones y de normativa.
- `regulation.integration.test.ts` comprueba la vigencia antes y después de medianoche en Copenhague, el acceso de ambos roles, la publicación exclusiva de administración y su auditoría, y la conservación de las versiones y caducidades históricas. También comprueba que los límites nuevos se aplican a las operaciones nuevas.
- Se verificó `/normativa` en Chromium contra TEST con sesiones de ambos perfiles. El acceso anónimo redirigió al inicio de sesión y la publicación quedó visible en el historial de administración con sus cambios.
- La generación de sesiones tiene cobertura de integración específica.

### Regresión de reservas, cancelaciones y caducidad

- Suite completa con `npm run test -- --configLoader runner --no-file-parallelism` en PostgreSQL TEST aislado. Pasaron 90 pruebas en 24 archivos. La base temporal se preparó con el flujo Drizzle hasta 0006.
- Recuperaciones. Conflicto con reserva ordinaria para ambos perfiles, reintento con consumo original y rollback ante una clave que pertenece a otra reserva o a otro alumno.
- Cancelación administrativa. La edición genérica rechaza `CANCELLED`. La operación específica cambia la sesión y las reservas, registra la versión y tramita las devoluciones.
- Racha y caducidad. La secuencia 1, 2, 5, 4 conserva una sola concesión. Al vencer un crédito ya consumido se conserva el saldo de otras concesiones.
- TypeScript y lint terminaron correctamente. Lint mantuvo tres avisos previos en `run-db-migrate.test.ts`.

### Generación de sesiones y reserva habitual

- `session-generation.integration.test.ts` verifica en PostgreSQL TEST aislado el CLI con retorno de fechas `Date` y texto ISO, desde una zona del proceso distinta de Copenhague.
- La cobertura comprueba los límites inclusivos de vigencia, las asignaciones solapadas, la versión aplicada, el aforo y los bloqueos activos. Incluye reintentos, concurrencia entre el CLI, la aplicación y la asignación, y el caso de aforo insuficiente sin selección parcial.
- El CLI y el servicio vuelven a informar del mismo identificador tras un reintento con aforo insuficiente, también cuando las plazas están bloqueadas. Se conserva una sola sesión y el reintento no inserta reservas.
- Pasaron 13 pruebas focalizadas de generación, asignación habitual y recurrencia. La suite completa pasó 98 pruebas en 25 archivos usando una base TEST aislada con las migraciones hasta 0006.

## Creación de clases únicas en administración

- `tests/e2e/one-off-class.spec.ts` comprueba en Chromium con PostgreSQL TEST aislado que `SUPER_ADMIN` crea una sola sesión y que el panel muestra la fecha y el intervalo elegidos en Copenhague tras guardar y recargar. La prueba compara también la fecha local y los instantes UTC guardados.
- El E2E omite la validación nativa del formulario para comprobar que el servidor rechaza un aforo de 13. También envía un formulario administrativo abierto tras cambiar a una sesión de alumno y verifica la redirección al panel de alumno y que la base queda sin una sesión nueva.
- La integración de normativa verifica el rechazo de un aforo de 3 cuando el límite vigente es 2 y la aceptación de una sola sesión con capacidad de 2. Se reutilizan las pruebas académicas del límite de 12 reservas por sesión.
- Pasaron los 8 E2E en Chromium y 13 pruebas focalizadas de integración académica y normativa en PostgreSQL TEST aislado. También pasaron TypeScript y el lint de los archivos del cambio.

## Cursos semanales e inscripciones

- `tests/e2e/course-enrollment.spec.ts` crea desde `/admin` un curso semanal que empieza más allá del horizonte móvil por defecto. Comprueba todas las fechas locales y horas UTC del periodo fijo, además de la inscripción ordinaria en el curso y en una clase única. Un alumno que presenta los formularios administrativos abiertos recibe una redirección a su panel y las operaciones quedan rechazadas.
- La integración académica comprueba que un horizonte de generación ampliado conserva la fecha final, que una 13.ª alta concurrente se rechaza y que se detecta un solapamiento que comienza después de la fecha de alta. También comprueba que un alumno elegible ocupa mediante una recuperación una plaza liberada para una fecha y que las inscripciones al curso se conservan.
- Pasaron los 10 E2E en Chromium y las 103 pruebas de Vitest con PostgreSQL TEST aislado y migrado hasta 0006. También pasaron TypeScript y el lint focalizado.

## E2E de créditos

- `tests/e2e/credits.spec.ts` usa cuentas sintéticas de alumno y administrador creadas por la fixture. Ejecutar contra una base PostgreSQL TEST local y aislada con las migraciones hasta 0006. Pasar su URL en `TEST_DATABASE_URL` antes de ejecutar `npm run test:e2e`. Playwright dirige Next.js a esa base y puede usar un puerto libre indicado con `E2E_PORT`. Si falta `TEST_DATABASE_URL`, se omiten los casos de créditos.
- El caso del alumno prepara dos cancelaciones habituales previas y calcula las fechas a partir de la antelación publicada en Copenhague. Desde el panel, el alumno cancela la tercera clase a tiempo y comprueba la plaza liberada y el crédito concedido. Luego reserva una recuperación con una plaza libre, vuelve al panel y verifica la confirmación, el saldo actualizado y un único consumo vinculado a la concesión.
- En Chromium pasaron los cinco E2E, incluidos el flujo del alumno y el acceso del administrador a créditos. Las comprobaciones en PostgreSQL se hicieron con datos sintéticos. Se corrigieron las redirecciones de éxito del inicio de sesión y de la reserva de recuperación que se trataban como errores.

- La regresión de cancelación de recuperación reproduce la navegación a un error tras cancelar correctamente. Verifica después de la corrección el mensaje de confirmación, la plaza liberada, el saldo restaurado y una única devolución con referencia al consumo, a la concesión y a la versión vigente. La prueba vuelve a consultar el panel para verificar el saldo y la devolución. Con esta regresión pasaron los seis E2E en Chromium contra TEST aislado.

### Cierre de fase 06

- **Cierre operativo DEV/TEST.** La rotación PostgreSQL quedó cerrada en 06.3.2.13, según el informe operativo local `docs/postgres-credential-rotation-06-3-2-5.md`. Este cierre conserva esa evidencia. La migración `0007_student_withdrawals` se ha aplicado únicamente en bases TEST aisladas. Su aplicación a DEV o producción queda fuera de este cierre.
- **Cierre funcional.** Quedan validados los cursos y clases únicas, la inscripción ordinaria y el límite de 12 alumnos simultáneos, la generación de sesiones, la normativa versionada, las cuentas y los flujos de créditos, recuperaciones y baja lógica. En TEST aislado pasaron 105 pruebas de Vitest y 13 E2E en Chromium, incluidos los de créditos y de baja. Pasaron TypeScript y `drizzle-kit check`. El lint completo terminó sin errores y con tres avisos preexistentes. [Modelo académico](academic-model.md#modelo-de-cursos-confirmado).
- **Sobreaforo.** La revisión de solo lectura identificó como única incidencia la fixture del 13 de enero de 2099. Tiene una plaza, una reserva confirmada y un alumno habitual pendiente. Sus datos se conservan. No se identificó una sesión operativa pendiente de resolución en las bases locales revisadas. [Detalle de la revisión](academic-model.md#siguiente-tarea-de-generación-de-sesiones).
- **Pendientes posteriores.** Quedan por definir el desempate automático, la vista administrativa de incidencias y la resolución de una sesión recurrente concreta desde el panel. También figuran como pendientes la especificación consolidada `PROJECT_SPEC.md` y el cambio de contraseña iniciado por un administrador. Los documentos del repositorio aún no definen un objetivo ni una primera tarea para la fase 7. [Incidencias de generación](academic-model.md#siguiente-tarea-de-generación-de-sesiones) · [Especificación](../README.md) · [Credenciales administrativas](authentication.md#cambio-de-contraseña-administrativo-pendiente).

## E2E de cuentas de alumno

- `tests/e2e/student-accounts.spec.ts` comprueba que `SUPER_ADMIN` puede crear una cuenta con su perfil académico y que se rechaza el mismo email con otra capitalización. El alumno entra con su contraseña inicial y cambia su propia contraseña. Se rechaza una contraseña actual incorrecta, se invalidan dos sesiones existentes y se comprueba que solo la contraseña nueva permite volver a entrar.
- La prueba de autorización presenta un formulario de alta abierto por un administrador después de cambiar a la sesión de un alumno. El servidor redirige a `/student` y la cuenta solicitada no existe en la base.
- Pasaron 12 E2E en Chromium, 103 pruebas de Vitest, TypeScript y lint focalizado. Las pruebas con base de datos usaron PostgreSQL TEST aislado con las migraciones hasta 0006.

## Baja lógica de alumno

- La integración académica cubre una clase pasada, tres reservas ordinarias futuras, una reserva ajena, bloqueos activos y dos recuperaciones futuras. Verifica que ambas recuperaciones liberan su plaza, con una única devolución vinculada al consumo y a la concesión, y que los reintentos conservan el ledger y la auditoría. También comprueba el acceso revocado, la inscripción de un sustituto y una recuperación elegible en plazas liberadas.
- La integración de recuperaciones verifica que una cancelación a tiempo con el crédito ya caducado registra una devolución sin restaurar saldo y que una clase ya iniciada conserva su reserva.
- `tests/e2e/student-withdrawal.spec.ts` comprueba la baja desde `/admin`, que el alumno desaparece de la lista de bajas y que la sesión del alumno queda invalidada y su nuevo intento de acceso es rechazado.
- Pasaron 105 pruebas de Vitest y 13 E2E en Chromium con PostgreSQL TEST aislado y migrado hasta `0007_student_withdrawals`. También pasaron TypeScript y `drizzle-kit check`. El lint completo terminó sin errores y con tres avisos previos en `run-db-migrate.test.ts`.

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
| E2E-CRED-001 | Cancelación habitual, crédito, reserva de recuperación y saldo actualizado desde el panel | E2E | `tests/e2e/credits.spec.ts` | Ejecutada correctamente en Chromium con PostgreSQL TEST aislado | `npm run test:e2e -- tests/e2e/credits.spec.ts` con `TEST_DATABASE_URL` |

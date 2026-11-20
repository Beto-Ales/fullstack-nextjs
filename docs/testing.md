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
- **Pendientes posteriores.** La [planificación general](../planificacion_general.md) define la fase 7 de recuperaciones y sitúa el panel administrativo en la fase 9. La vista de incidencias de aforo y la resolución de sesiones recurrentes desde el panel quedan para esa fase. Siguen pendientes la decisión sobre desempate automático y el cambio de contraseña iniciado por un administrador. [Incidencias de generación](academic-model.md#siguiente-tarea-de-generación-de-sesiones) · [Credenciales administrativas](authentication.md#cambio-de-contraseña-administrativo-pendiente).

## E2E de cuentas de alumno

- `tests/e2e/student-accounts.spec.ts` comprueba que `SUPER_ADMIN` puede crear una cuenta con su perfil académico y que se rechaza el mismo email con otra capitalización. El alumno entra con su contraseña inicial y cambia su propia contraseña. Se rechaza una contraseña actual incorrecta, se invalidan dos sesiones existentes y se comprueba que solo la contraseña nueva permite volver a entrar.
- La prueba de autorización presenta un formulario de alta abierto por un administrador después de cambiar a la sesión de un alumno. El servidor redirige a `/student` y la cuenta solicitada no existe en la base.
- Pasaron 12 E2E en Chromium, 103 pruebas de Vitest, TypeScript y lint focalizado. Las pruebas con base de datos usaron PostgreSQL TEST aislado con las migraciones hasta 0006.

## Baja lógica de alumno

- La integración académica cubre una clase pasada, tres reservas ordinarias futuras, una reserva ajena, bloqueos activos y dos recuperaciones futuras. Verifica que ambas recuperaciones liberan su plaza, con una única devolución vinculada al consumo y a la concesión, y que los reintentos conservan el ledger y la auditoría. También comprueba el acceso revocado, la inscripción de un sustituto y una recuperación elegible en plazas liberadas.
- La integración de recuperaciones verifica que una cancelación a tiempo con el crédito ya caducado registra una devolución sin restaurar saldo y que una clase ya iniciada conserva su reserva.
- `tests/e2e/student-withdrawal.spec.ts` comprueba la baja desde `/admin`, que el alumno desaparece de la lista de bajas y que la sesión del alumno queda invalidada y su nuevo intento de acceso es rechazado.
- Pasaron 105 pruebas de Vitest y 13 E2E en Chromium con PostgreSQL TEST aislado y migrado hasta `0007_student_withdrawals`. También pasaron TypeScript y `drizzle-kit check`. El lint completo terminó sin errores y con tres avisos previos en `run-db-migrate.test.ts`.

## Fase 07 — Disponibilidad y concurrencia de recuperaciones

- [El plan general](../planificacion_general.md#8-recuperación-de-clases) define la búsqueda de plazas, la validación de créditos, la reserva y la protección contra concurrencia. El E2E de `tests/e2e/credits.spec.ts` usa dos sesiones de Chromium independientes y un crédito válido ya concedido por alumno. Las clases llenas o con la última plaza bloqueada quedan fuera del listado.
- La prueba espera los dos envíos reales del formulario antes de liberarlos. Cualquiera de los alumnos puede ganar. El panel del ganador confirma la recuperación y muestra saldo cero. El del otro alumno avisa que la plaza ya no está disponible y conserva el saldo de un crédito. La clase desaparece de ambos listados y PostgreSQL registra una reserva y un débito vinculados.
- El primer intento reprodujo el aviso en inglés. El panel ahora traduce el conflicto de aforo; la transacción y las reglas de créditos se conservan. Las diferencias de concesión y de ausencias entre el plan y el código quedan anotadas en el [modelo académico](academic-model.md#cancelaciones-y-secuencias).
- Pasaron los 14 E2E de Chromium, tres repeticiones focalizadas del nuevo E2E y la integración de concurrencia por la última plaza, en bases PostgreSQL TEST aisladas migradas hasta 0007. TypeScript pasó y el lint completo terminó sin errores, con los tres avisos preexistentes.
- La regresión de listado prepara 50 sesiones llenas, 50 bloqueadas y una posterior con una plaza libre. Antes de la corrección, la consulta devolvía una lista vacía. Ahora PostgreSQL excluye las sesiones sin plaza y las ya reservadas por el alumno antes de devolver hasta 100 resultados en orden cronológico. La prueba también comprueba el límite al añadir otras 100 sesiones disponibles. Se conserva la comprobación transaccional de aforo al reservar. [Consulta de disponibilidad](../src/application/recovery/recovery-service.ts).
- Tras corregir el listado, pasaron las 106 pruebas de Vitest, incluidas las 20 de integración de recuperaciones, y los 14 E2E de Chromium en PostgreSQL TEST aislado. TypeScript pasó y el lint terminó sin errores, con tres avisos preexistentes.
- **Ver más clases** añade hasta 100 sesiones disponibles por respuesta. El cursor usa la hora UTC de inicio con la precisión de PostgreSQL y el identificador de sesión. Solo se ofrece otro bloque si queda algún resultado. Agregar bloques conserva las filas anteriores sin duplicar identificadores.
- El E2E de paginación navega por 101 clases disponibles y comprueba el orden exacto, con dos clases a la misma hora justo en el límite. Las clases llenas o bloqueadas quedan fuera de ambos bloques. Tras reservar la última clase, la lista se actualiza y PostgreSQL confirma la reserva.
- Con la paginación pasaron 106 pruebas de Vitest y 15 E2E de Chromium en PostgreSQL TEST aislado. Las ejecuciones focalizadas también verificaron la última plaza, el orden del cursor y la concurrencia. TypeScript pasó y el lint terminó sin errores, con tres avisos preexistentes.
- **Cierre de fase 07.** La revisión confirmó la paginación y volvió a ejecutar los E2E de la clase 101 y de la última plaza, junto con las pruebas de integración del cursor y de concurrencia. Quedan verificados los requisitos del [plan](../planificacion_general.md#8-recuperación-de-clases): búsqueda de plazas, crédito válido, límite mensual de celebración, reserva y consumo atómicos, y protección contra la doble reserva y el doble consumo.
- La [fase 8 del plan](../planificacion_general.md#10-panel-del-estudiante) continúa con el panel del alumno. La vista administrativa de incidencias sigue en fase 9. Las discrepancias sobre la racha de cancelaciones quedan pendientes de decisión en el [modelo académico](academic-model.md#cancelaciones-y-secuencias).

## Fase 08 — Calendario semanal del alumno

- `/student` abre en la semana actual de lunes a domingo en `Europe/Copenhagen`. La consulta usa el usuario autenticado y el intervalo entre los dos lunes locales para devolver sus reservas confirmadas. La vista agrupa por día, ordena por hora y distingue clases habituales, ordinarias y recuperaciones. Usa el nombre de la plantilla cuando existe y muestra «Clase única» para sesiones sin plantilla.
- El E2E `tests/e2e/student-calendar.spec.ts` cubre una clase habitual y una recuperación confirmada en la semana actual, navegación en ambos sentidos, estado vacío y un domingo y un lunes locales que comparten fecha UTC. Verifica que quedan fuera las reservas de otro alumno y las canceladas. En una ventana de 360 px comprueba que el calendario cabe sin desplazamiento horizontal.
- Tras cancelar una recuperación desde el calendario, el panel conserva la semana elegida y actualiza su contenido. Las acciones de cancelación, el flujo de créditos y la búsqueda paginada de recuperaciones se conservan.
- Pasaron 106 pruebas de Vitest y 16 E2E de Chromium en PostgreSQL TEST aislado, incluidos el calendario y las regresiones de cancelación, créditos y recuperaciones. TypeScript pasó y lint terminó sin errores, con tres avisos preexistentes.
- Las diferencias sobre la racha quedan en el [modelo académico](academic-model.md#cancelaciones-y-secuencias) y la vista administrativa de incidencias sigue en fase 9.

### Horarios habituales del alumno

- `/student` consulta solo las asignaciones del usuario autenticado. La vigencia se calcula con el intervalo común de la inscripción y del curso, en la fecha local de Copenhague. El panel distingue «Vigente» de «Próximo» y oculta las inscripciones vencidas. Muestra curso, día e intervalo de hora local.
- El E2E `tests/e2e/student-schedules.spec.ts` cancela una clase desde el calendario. La sesión desaparece, el horario habitual permanece y PostgreSQL conserva las fechas de la inscripción. También comprueba la exclusión de asignaciones ajenas y vencidas, la identificación de un curso futuro y el estado vacío.
- Pasaron 106 pruebas de Vitest y 17 E2E en Chromium con PostgreSQL TEST aislado. TypeScript pasó y lint terminó sin errores, con tres avisos preexistentes.
- El [plan](../planificacion_general.md#19-criterios-generales-de-calidad) exige diseño responsive e interfaz accesible. Una revisión visual transversal queda como propuesta pendiente de planificación.

### Historial de clases del alumno

- `/student` consulta solo las reservas del alumno autenticado. El historial ordena por fecha de clase, de más reciente a más antigua, y presenta el nombre, el tipo de reserva y el resultado en hora de Copenhague. Las recuperaciones pendientes mantienen la acción de cancelación. Las recuperaciones realizadas o canceladas se muestran en el historial.
- La vista usa la asistencia vigente tras una corrección. Distingue «Falta registrada» de «Sin asistencia registrada» y muestra el tipo de cancelación cuando quedó registrado.
- El E2E `tests/e2e/student-history.spec.ts` comprueba los resultados registrados, la exclusión de datos ajenos, el orden, el estado vacío y la vista a 360 px. La regresión de créditos confirma que una recuperación cancelada pasa al historial y deja de aparecer entre las recuperaciones pendientes.
- Pasaron 106 pruebas de Vitest y 18 E2E de Chromium en PostgreSQL TEST aislado. La repetición focalizada de historial, calendario y créditos pasó los 7 casos. TypeScript pasó y lint terminó sin errores, con tres avisos preexistentes.

### Vencimientos de créditos del alumno

- El panel usa el remanente por concesión del ledger para calcular el saldo disponible, el crédito FIFO estimado y los vencimientos. Solo muestra créditos propios disponibles. Agrupa las cantidades con el mismo vencimiento, usa hora de Copenhague y deja al final los créditos sin vencimiento. El plan carece de un plazo para «próximos a caducar», por lo que la vista incluye todo el saldo utilizable.
- El E2E `tests/e2e/student-credit-expirations.spec.ts` comprueba el estado vacío, el orden, el remanente parcial y la exclusión de créditos ajenos, agotados y caducados. Al reservar una recuperación, el saldo baja y desaparece el vencimiento agotado. Al cancelar a tiempo, el crédito vigente vuelve a su fecha original. Una devolución auditada por crédito caducado conserva el saldo y el listado.
- Pasaron 106 pruebas de Vitest y 19 E2E de Chromium en PostgreSQL TEST aislado. La repetición focalizada de vencimientos y flujos de crédito pasó los 6 casos. TypeScript pasó y lint terminó sin errores, con tres avisos preexistentes.
- **Validación de cierre.** Se revisó el diff desde `cb2b29d` y se confirmó que el saldo y los vencimientos usan los mismos remanentes. El consumo FIFO sigue el orden por vencimiento, fecha de concesión e identificador. La devolución conserva el vencimiento original y solo restaura saldo si sigue vigente. En esta revisión pasaron 6 E2E de Chromium y 30 pruebas de Vitest de FIFO, créditos y recuperaciones. Las pruebas con base de datos usaron PostgreSQL TEST aislado. También pasaron TypeScript y lint, con tres avisos preexistentes. Estas ejecuciones se añaden a las suites completas del incremento anterior.
- **Cierre de fase 08.** Queda validado el [alcance del panel del estudiante](../planificacion_general.md#10-panel-del-estudiante) con próximas clases, calendario, horarios, cancelaciones, saldo, vencimientos, historiales, búsqueda de recuperaciones y normativa. La decisión sobre la racha y la propuesta de revisión visual transversal siguen pendientes por separado.

## Fase 09 — Calendario semanal global

- `/admin` requiere `SUPER_ADMIN`. El calendario de solo lectura comparte con el panel del alumno la semana de lunes a domingo en `Europe/Copenhagen`, la navegación y el formato horario. Incluye las sesiones de cursos y las clases únicas de la semana elegida.
- Por sesión se muestran el aforo efectivo según la normativa vigente, las reservas confirmadas, los bloqueos activos y las plazas libres. Para sesiones recurrentes futuras de cursos activos se cuentan los alumnos con asignación vigente que siguen sin reserva. La indicación de incidencia aparece si superan las plazas libres.
- Un alumno que canceló voluntariamente su reserva ordinaria para esa fecha conserva su inscripción habitual. El calendario excluye ese caso del recuento de pendientes y muestra la plaza liberada.
- El E2E `tests/e2e/admin-calendar.spec.ts` comprueba navegación y estado vacío, el límite local entre domingo y lunes, las plazas libres, los bloqueos activos, la incidencia de aforo, el efecto de una cancelación voluntaria y el rechazo de acceso a un alumno.
- Pasaron 106 pruebas de Vitest y 20 E2E de Chromium en PostgreSQL TEST aislado. También pasaron las dos pruebas focalizadas de calendarios, con un caso de aforo almacenado superior al límite vigente. TypeScript pasó y el lint terminó sin errores, con tres avisos preexistentes. La fixture de 2099 se verificó en solo lectura y conserva su reserva confirmada.
- El siguiente pendiente del [apartado 11](../planificacion_general.md#11-panel-administrativo) es mostrar los alumnos inscritos por sesión. Los desempates, las discrepancias sobre la racha y la revisión visual transversal siguen pendientes por separado.

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

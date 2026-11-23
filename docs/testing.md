# Testing

## Objetivo en esta fase

Dejar lista una infraestructura de pruebas segura y mantenible, sin tocar datos reales.

## Herramientas

- **Vitest**: unitarias/integración técnica.
- **Playwright**: pruebas e2e.

## Estructura

- Unitarias/integración: `src/**/*.test.ts`
- E2E: `tests/e2e/**/*.spec.ts`

## Comandos vigentes desde 10.6

| Comando | Alcance y destino |
| --- | --- |
| `npm run test:unit` | Unitarias sin PostgreSQL ni Docker. |
| `npm run test:watch` | Unitarias en modo observación. |
| `npm run test:integration` | Integraciones completas sobre PostgreSQL 15 desechable. Admite filtros de Vitest. |
| `npm test` | Todas las unitarias e integraciones. La ausencia de PostgreSQL desechable hace fallar la ejecución. |
| `npm run test:e2e` | Chromium con Next.js dedicado y una instancia desechable distinta. |
| `npm run test:e2e:pending` | Regresión de créditos pendientes, con una versión sintética de normativa en otra instancia desechable. |
| `npm run test:verify` | Vitest completo, Chromium y la regresión de créditos pendientes. Cada etapa debe aprobar. |

Para las pruebas de escritura, iniciar Docker y disponer localmente de la imagen `postgres:15`. Si falta, ejecutar `docker pull postgres:15`. Para Chromium, instalar el navegador con `npx playwright install chromium` si hace falta. El repositorio carece de pipeline de CI. Un agente de CI puede preparar esos requisitos y ejecutar `npm run test:verify` sin credenciales persistentes.

## Base de datos para pruebas

El aprovisionador crea su propio `TEST_DATABASE_URL` y su identidad de ejecución. Quita las asignaciones manuales de `TEST_DATABASE_URL` y `POSTGRES_TEST_RUN` antes de arrancar los comandos. El proceso valida el contenedor Docker, el puerto local, la identidad del servidor PostgreSQL, la base, el rol y el marcador antes de migrar. Vitest serializa los archivos que comparten la base. Playwright comprueba el destino antes de arrancar Next, elige un puerto local y rechaza servidores preexistentes. Con `E2E_PORT` se puede solicitar un puerto concreto.

```console
npm run test:integration -- recovery.integration.test.ts
npm run test:e2e -- credits.spec.ts
```

Las secciones históricas siguientes registran resultados y procedimientos anteriores. Para repetirlas, usa los comandos vigentes de arriba. [Diseño y límites](#incremento-106--aislamiento-de-pruebas-postgresql)

### Resultado operativo de infraestructura (Fase 06.2)

- Validación de Compose completada con `.env.compose.local` sin exponer secretos.
- Ambos PostgreSQL en ejecución con `healthy`.
- Confirmada separación de entorno:
  - puertos distintos (`5432` y `5433`),
  - bases distintas (`fullstack_nextjs` y `fullstack_nextjs_test`),
  - volúmenes persistentes independientes.
- No se ejecutaron migraciones ni operaciones destructivas durante esta validación.

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
- En la revisión previa al commit se repitieron los dos E2E de calendarios y las diez pruebas de generación y asignaciones habituales. Pasaron en PostgreSQL TEST aislado.

### Inscritos por sesión

- «Ver inscritos» abre un detalle de solo lectura protegido por `SUPER_ADMIN`, también al abrir la URL directamente. Muestra el nombre de cada alumno con reserva confirmada y distingue plazas ordinarias y de recuperación. El enlace de vuelta conserva la semana elegida.
- El E2E `tests/e2e/admin-session-enrollments.spec.ts` compara el total con el calendario, comprueba ambos tipos de plaza, excluye reservas canceladas y de otras sesiones, valida el estado vacío y comprueba el rechazo de acceso a un alumno. Al volver, sigue visible el indicador de habituales pendientes.
- En PostgreSQL TEST aislado pasaron tres E2E de Chromium, el detalle de inscritos y los calendarios del administrador y del alumno. TypeScript y el lint focalizado pasaron.

### Cancelaciones por sesión

- El detalle de sesión incluye un historial de solo lectura ordenado por fecha de cancelación, de la más reciente a la más antigua. Muestra la hora de Copenhague, el tipo de reserva y, cuando constan, el rol de quien canceló, la clasificación temporal y el motivo de no elegibilidad para crédito. Las cancelaciones siguen visibles cuando se vuelve a ocupar la plaza.
- El E2E de inscritos cubre también la coexistencia con reservas confirmadas, los dos tipos de cancelación, la hora local, el orden, el estado vacío, la exclusión de otras sesiones y la protección de la URL directa.
- Pasaron los dos E2E focalizados en Chromium con PostgreSQL TEST aislado, el detalle de inscritos y cancelaciones y el calendario administrativo. TypeScript y el lint focalizado pasaron. La fixture de 2099 se verificó en solo lectura.
- El detalle conserva este flujo de consulta. La gestión de asistencia desde la interfaz corresponde al incremento 9.2 del [apartado 11](../planificacion_general.md#11-panel-administrativo).

### Incremento 9.1 — Garantías del servidor para asistencia

- [`attendance.integration.test.ts`](../src/application/academic/attendance.integration.test.ts) cubre los dos resultados, las acciones por rol, sesión y reserva, el instante exacto de fin, reprogramaciones, idempotencia y correcciones con auditoría. Las pruebas concurrentes comparten PostgreSQL y comprueban la exclusión con el alta, la corrección, la cancelación y el detector existente. También verifican el historial y que `ABSENT` deja intacto el ledger.
- Pasaron **126 pruebas de Vitest**, incluidas **20 nuevas de asistencia**, y **21 E2E de Chromium** en dos bases desechables de PostgreSQL 17.12, cada una con las ocho migraciones del journal. TypeScript pasó y ESLint registró tres avisos preexistentes, sin errores. La primera pasada E2E compartió base con Vitest y falló en la paginación por sesiones residuales. La repetición completa en una base E2E vacía pasó.
- Las suites de integración reinician tablas. Para repetirlas, usar una base TEST desechable, inequívocamente distinta de DEV, con las migraciones hasta `0007`. En Windows, usar `npm.cmd` si PowerShell bloquea `npm.ps1`.

```powershell
npm.cmd run test -- --configLoader runner --no-file-parallelism
```

- Ejecutar Playwright con `TEST_DATABASE_URL` apuntando a otra base TEST recién migrada o en una base TEST vacía antes de correr Vitest. El E2E de paginación necesita que el conjunto inicial de sesiones pertenezca a sus propias fixtures.

```powershell
npm.cmd run test:e2e -- --workers=1
```

- Los datos históricos con asistencia y cancelación se conservan. El historial de clases da prioridad a la cancelación. La política de la racha y la revisión visual transversal siguen en incrementos posteriores.

### Incremento 9.2 — Control de asistencia en el detalle de sesión

- `Control de asistencia` muestra en un solo listado las reservas confirmadas ordinarias y de recuperación, con el resultado vigente. El servidor calcula la elegibilidad al cargar o actualizar el detalle. Las sesiones futuras, en curso o canceladas se consultan en modo lectura. Las cancelaciones y sus resultados históricos excepcionales siguen visibles.
- El formulario registra `Asistió` o `Ausente`. La corrección ofrece el resultado alternativo y exige un motivo. Cada envío verifica `SUPER_ADMIN` y usa las acciones del incremento 9.1. La interfaz muestra el estado de envío, confirma tras la respuesta del servidor y vuelve a consultar el detalle manteniendo la semana. Un conflicto por un resultado que ya cambió muestra un aviso y actualiza el estado visible.
- [`admin-calendar.integration.test.ts`](../src/application/academic/admin-calendar.integration.test.ts) verifica la consulta agrupada, la autorización, la asociación por reserva, el resultado vigente tras corregir y la separación de cancelaciones. [`admin-session-enrollments.spec.ts`](../tests/e2e/admin-session-enrollments.spec.ts) cubre los estados, la edición en móvil y mediante teclado, un formulario desactualizado, motivos inválidos, revalidación de permisos y la navegación de vuelta.
- Pasaron **127 pruebas de Vitest**, incluidas las 20 de asistencia del 9.1, y **23 E2E de Chromium**. Ambas suites usaron bases desechables separadas en el contenedor TEST de Compose con **PostgreSQL 15.20** y las ocho migraciones del journal. La base TEST habitual tenía siete migraciones. TypeScript pasó y ESLint registró cero errores y tres avisos preexistentes.

### Incremento 9.3 — Aforo y disponibilidad en el detalle de sesión

- La sección distingue capacidad física, aforo efectivo, reservas confirmadas, bloqueos activos, plazas físicamente libres y plazas reservables. Calendario y detalle comparten los recuentos y la normativa vigente. Ambos muestran cero plazas reservables para sesiones en curso, finalizadas o canceladas. El detalle conserva los recuentos registrados y muestra las incidencias de aforo y los habituales pendientes.
- El [modelo de disponibilidad](academic-model.md#aforo-en-el-detalle-administrativo) documenta el significado de los recuentos, el efecto de las cancelaciones y la diferencia entre capacidad de sesión y elegibilidad del alumno. La consulta puntual de recuperaciones conserva el recuento de plazas por capacidad. La búsqueda de recuperaciones y la transacción aplican además el estado y la hora de inicio.
- [`admin-calendar.integration.test.ts`](../src/application/academic/admin-calendar.integration.test.ts) compara el detalle con el calendario y con la búsqueda de recuperaciones. Cubre sesiones vacías, parciales y completas, bloqueos históricos y activos, cancelación y sustitución, reducción normativa, sobreaforo, habituales pendientes y autorización. [`admin-session-enrollments.spec.ts`](../tests/e2e/admin-session-enrollments.spec.ts) comprueba los recuentos, la lectura a 360 px, el acceso desde el calendario, los estados de sesión y la convivencia con asistencia y cancelaciones.
- Pasaron **141 pruebas de Vitest**, incluidas **14 nuevas de aforo**, y **23 E2E de Chromium**. Las suites usaron dos bases TEST desechables y separadas en PostgreSQL **15.20**, con las ocho migraciones del journal. TypeScript pasó y ESLint registró cero errores y tres avisos preexistentes. La base TEST habitual conserva sus siete migraciones.

### Incremento 9.4 — Bloqueo y desbloqueo administrativo de plazas

- El detalle admite altas y desactivaciones con motivo obligatorio, y muestra las filas activas e históricas con su auditoría. Cada alta lleva un UUID estable para reintentos. La desactivación conserva el primer motivo, actor y fecha. Tras guardar se revalidan el detalle, el calendario administrativo y el panel del alumno.
- [`capacity-blocks.integration.test.ts`](../src/application/academic/capacity-blocks.integration.test.ts) comprueba validaciones, auditoría, reintentos y concurrencia con otro administrador, con reservas ordinarias y con recuperaciones. También comprueba una reducción normativa mientras una petición espera el bloqueo de sesión, la liberación de aforo y el filtrado de plazas bloqueadas en la búsqueda del alumno.
- [`admin-session-enrollments.spec.ts`](../tests/e2e/admin-session-enrollments.spec.ts) verifica bloqueo y desbloqueo a 360 px, teclado, datos de auditoría, actualización de ambos recuentos, rechazo de una solicitud desactualizada y rechazo de ambos formularios al perder el rol de administrador.
- Para probar el 9.4, preparar una base TEST desechable por suite con el journal hasta `0008_session_capacity_block_release`. La actualización desde `0007` se verificó con un bloqueo activo y otro histórico preexistentes. Ambos conservaron estado, cantidad y motivo, y los nuevos campos quedaron vacíos.
- Pasaron **156 pruebas de Vitest**, incluidas **15 de bloqueo y desbloqueo**, y **24 E2E de Chromium** en bases TEST desechables y separadas de PostgreSQL **15.20**, con nueve migraciones. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes. La base TEST habitual conserva sus siete migraciones.

### Incremento 9.5 — Inscripción ordinaria desde el detalle de sesión

- [Modelo académico](academic-model.md#inscripción-administrativa-en-una-sesión). El detalle permite buscar y confirmar la inscripción ordinaria de un alumno activo en una sesión programada y futura.
- [Integración PostgreSQL](../src/application/academic/session-enrollment.integration.test.ts). Cubre autorización, búsqueda acotada, homónimos, estudiantes inactivos, sesiones cerradas, capacidad física y efectiva, bloqueos, habituales pendientes, reintentos, cancelaciones históricas, auditoría y ausencia de movimientos. Comprueba la exclusión con recuperaciones, bloqueos y reservas ordinarias, el reloj tras esperar el bloqueo de sesión y la equivalencia de aforo en calendario y detalle.
- [Chromium](../tests/e2e/admin-session-enrollments.spec.ts). Comprueba búsqueda, confirmación y navegación con teclado a 360 px, aforo actualizado, conservación de bloqueos, semana administrativa, panel del alumno y rechazo de solicitudes inválidas, desactualizadas o sin el rol requerido.
- Preparar bases TEST desechables y separadas por suite con el journal hasta `0009_admin_session_enrollment`. En PostgreSQL 15.20 se verificó también la actualización desde `0008` con una reserva confirmada y otra cancelada. Ambas conservaron sus datos y el creador quedó a nulo.
- Pasaron **171 pruebas de Vitest**, incluidas **15 nuevas de integración**, y **26 E2E de Chromium sin reintentos**. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes. La base TEST habitual conserva sus siete migraciones.

### Incremento 9.6 — Cancelación individual auditada

- [Modelo académico](academic-model.md#cancelación-individual-por-decisión-administrativa). El detalle permite a `SUPER_ADMIN` confirmar con motivo la cancelación de una reserva ordinaria futura. La decisión queda fuera de la racha y el ledger.
- [Integración PostgreSQL](../src/application/academic/session-enrollment.integration.test.ts). Cubre la auditoría y la transición de una reserva del 9.5, aforo e historial, conservación del curso, validaciones, reintentos y concurrencia con administradores, alumno, cancelación de sesión, asistencia y nueva inscripción. Una decisión administrativa intercalada conserva la concesión vigente para la tercera cancelación elegible del estudiante.
- [Chromium](../tests/e2e/admin-session-enrollments.spec.ts). Comprueba identificación, confirmación y validación mediante teclado a 360 px, recuentos, un intento desactualizado, el cambio de rol, el historial de ambos paneles y la semana de origen.
- Usar bases TEST desechables separadas con el journal hasta `0010_admin_reservation_cancellation`. Se verificó la actualización desde `0009` en PostgreSQL 15.20 con cancelaciones históricas ejecutadas por ambos roles. Los registros y actores se conservaron y las columnas nuevas quedaron a nulo.
- Pasaron **177 pruebas de Vitest**, incluidas **6 nuevas de integración**, y **28 E2E de Chromium sin reintentos**. TypeScript y `drizzle-kit check` pasaron. ESLint registró cero errores y tres avisos preexistentes. El TEST persistente conserva sus siete migraciones.

### Incremento 9.7 — Perfil administrativo del alumno

- [Modelo y reglas de consulta](academic-model.md#perfil-administrativo-del-alumno). La ficha `/admin/alumnos/[studentId]` está disponible desde el listado y el detalle de sesión. Funciona con cuentas activas y desactivadas.
- [Integración PostgreSQL](../src/application/academic/admin-student-profile.integration.test.ts). Cubre autorización, UUID inválidos e inexistentes, proyección de cuenta, vigencia de asignaciones, reservas futuras, versiones de asistencia, orígenes de cancelación, registros incompletos, totales y orden estable de páginas. Compara el saldo con el servicio existente y verifica que la consulta conserva el ledger y que el historial sobrevive a la baja.
- [Chromium](../tests/e2e/admin-student-profile.spec.ts). Cubre acceso desde listado y sesión, navegación por teclado a 360 px, datos y secciones, paginación, regreso al punto de partida, acceso directo por URL, baja e información vacía.
- Ejecutar Vitest con `--maxWorkers=1` por la limpieza de tablas entre casos. Usar bases desechables independientes para Vitest y Playwright con `TEST_DATABASE_URL` y el journal hasta `0010_admin_reservation_cancellation`. La ficha usa el esquema existente.
- El 22 de noviembre de 2026 pasaron **183 pruebas de Vitest**, incluidas **6 nuevas de integración**, y **31 E2E de Chromium sin reintentos**, incluidos los **3 nuevos**. Cada base desechable de PostgreSQL **15.20** tenía las once migraciones aplicadas. TypeScript y `drizzle-kit check` pasaron. ESLint registró cero errores y tres avisos preexistentes.

### Incremento 9.8 — Edición auditada del alumno

- [Integración PostgreSQL](../src/application/academic/student-edit.integration.test.ts). Verifica validación y normalización, autorización, inactivación concurrente, reenvíos, conflictos de versión, unicidad concurrente de correo, reversión íntegra ante un fallo de auditoría y conservación de los registros académicos. Comprueba el acceso con el correo nuevo, el rechazo del anterior, el login en curso y la continuidad de sesiones existentes.
- [Chromium](../tests/e2e/admin-student-edit.spec.ts). Verifica edición y cancelación por teclado a 360 px, persistencia al recargar, conservación del historial y el contexto, mensajes de campo, conflictos, rechazo de campos adicionales y protección de una acción abierta al cambiar a una sesión de alumno.
- Usar bases desechables independientes con el journal hasta `0011_student_profile_edit_audit`. Ejecutar Vitest con `--maxWorkers=1` por la limpieza de tablas entre casos.
- El 22 de noviembre de 2026 pasaron **190 pruebas de Vitest**, incluidas **7 nuevas de integración**, y **34 E2E de Chromium sin reintentos**, incluidos **3 nuevos**. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes. Las suites usaron bases desechables separadas de PostgreSQL **15.20**. Una tercera base confirmó que la actualización de `0010` a `0011` conserva un usuario y un perfil existentes y crea la tabla de auditoría vacía.

### Incremento 9.9 — Historial de modificaciones del alumno

- [Integración PostgreSQL](../src/application/academic/student-edit.integration.test.ts). Cubre autorización y UUID inválidos, aislamiento entre alumnos, valores persistidos y reenvíos, auditoría tras baja lógica, filtrado de datos históricos, orden con empates y paginación independiente.
- [Chromium](../tests/e2e/admin-student-edit.spec.ts). Verifica el historial vacío, la aparición de una edición del 9.8, la consulta de cuentas desactivadas, los valores anteriores y nuevos, el escape de HTML, el aislamiento, la navegación por teclado a 360 px y el rechazo de `STUDENT`.
- Usar bases TEST desechables independientes con el journal hasta `0011_student_profile_edit_audit`. Ejecutar Vitest con `--maxWorkers=1`.
- El 22 de noviembre de 2026 pasaron **193 pruebas de Vitest**, incluidas **3 nuevas de integración**, y **35 E2E de Chromium sin reintentos**, incluido **1 nuevo**. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes. Ambas suites usaron bases desechables de PostgreSQL **15.20** con las doce migraciones aplicadas.

### Incremento 9.10 — Racha y créditos pendientes

- [Pruebas de dominio](../src/domain/academic/cancellation-rules.test.ts). Cubren las cinco posiciones, cambios de límite, cancelaciones tardías, resultados pendientes, reinicio por asistencia o ausencia, reinscripciones y desempates.
- [Integración PostgreSQL](../src/application/academic/regulation.integration.test.ts). Comprueba activación normativa, auditoría anterior, reintentos, concurrencia, prioridad de solicitud, cambio de mes, caducidad desde la concesión, reprogramación y resolución tras registrar asistencia, ausencia o una cancelación anterior.
- [Chromium](../tests/e2e/credits.spec.ts). El flujo de la racha pendiente requiere una versión revisada vigente en la base desechable de Playwright con máximo tres y los demás valores iniciales. La prueba cancela por teclado a 360 px, verifica que la plaza se libera con saldo cero y comprueba que la ausencia anterior registrada desde administración desbloquea el crédito.
- Ejecutar las suites en bases desechables separadas con el journal hasta `0012_consecutive_cancellation_eligibility`. Usar `--maxWorkers=1` para Vitest.
- El 22 de noviembre de 2026 pasaron **204 pruebas de Vitest** y **36 E2E de Chromium sin reintentos** con PostgreSQL **15.20**. Se verificó en una tercera base desechable que la actualización de `0011` a `0012` conserva la normativa, una cancelación consolidada y su movimiento de crédito. TypeScript y `drizzle-kit check` pasaron. ESLint registró cero errores y tres avisos preexistentes.

### Incremento 9.11 — Resumen semanal administrativo

- [Integración PostgreSQL](../src/application/academic/admin-calendar.integration.test.ts). Cubre autorización, semanas vacías y mixtas, cambios de mes y año, ambos cambios de hora, resultados de asistencia vigentes, procedencia de cancelaciones y coincidencia del aforo con el detalle.
- [Chromium](../tests/e2e/admin-calendar.spec.ts). Comprueba los indicadores, la navegación por teclado a 360 px, la semana al regresar del detalle y el acceso exclusivo de administración.
- Ejecutar sobre bases TEST desechables separadas con el journal existente hasta `0012`. El resumen usa consultas de solo lectura y conserva la normativa publicada del entorno.
- El 22 de noviembre de 2026 pasaron **209 pruebas de Vitest**, incluidas **5 nuevas de integración**, y **36 pruebas de Chromium sin reintentos** en PostgreSQL **15.20**. La suite completa omitió el caso de crédito pendiente al estar vigente la regla anterior. Ese caso pasó por separado en la base TEST desechable del 9.10, que ya tenía una versión de prueba activa. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes.

### Incremento 10.2 — Ajustes manuales de créditos

- [Integración PostgreSQL](../src/application/credits/credit-service.integration.test.ts). Comprueba normalización, identidad, autorización vigente, unicidad, histórico, retiros de varias concesiones y rollback de una retirada parcial. Los casos concurrentes mantienen el perfil bloqueado desde una conexión independiente y comprueban las esperas de PostgreSQL antes de liberarlo.
- [Chromium](../tests/e2e/credits.spec.ts). Comprueba la confirmación tras guardar, la recuperación de una respuesta perdida, el conflicto por una solicitud anterior, los errores de validación y saldo, el acceso por rol y la interacción por teclado a 360 px.
- Ejecutar en PostgreSQL 15 con el journal hasta `0013` en bases desechables verificadas. Pasar la conexión explícitamente en `TEST_DATABASE_URL` para evitar la alternativa a DEV en Playwright y usar `--maxWorkers=1` en Vitest. La regresión de créditos pendientes del 9.10 requiere el escenario de normativa revisada en su base desechable.
- En PostgreSQL **15.20** pasaron **45 pruebas focalizadas** y **216 pruebas de Vitest** en la suite completa. Chromium pasó **37 casos** en la suite completa con la normativa anterior. El único caso omitido, de créditos pendientes, pasó por separado con una versión sintética de la normativa revisada. Se comprobó la actualización `0012` → `0013` en otra base desechable con un movimiento histórico sintético que conservó todos sus valores originales. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes.

### Incremento 10.3 — Orden de bloqueos en ajustes de créditos

- [Integración PostgreSQL](../src/application/credits/credit-service.integration.test.ts). Una conexión independiente bloquea brevemente la escritura del ledger mientras el ajuste conserva sus bloqueos de fila. `pg_blocking_pids` confirma dónde espera la operación académica antes de liberar la conexión. En el código de 10.2, la cancelación global esperaba el perfil y PostgreSQL devolvió `40P01`. El 10.3 hace que la espera se produzca en la sesión en ese mismo escenario.
- Los casos dirigidos también comprueban reprogramación y retirada distribuida, alta y cancelación de recuperación, ajustes sin referencia o en otra sesión, reenvíos concurrentes y confirmados, conflicto de UUID y rollback de una referencia inexistente. El cierre revierte la transacción de sincronización y espera a que terminen las operaciones.
- Ejecutar Vitest y Chromium en bases desechables separadas con journal hasta `0013` y `TEST_DATABASE_URL` explícita. Los límites de espera para reproducir la regresión se aplican solo a las conexiones de prueba. H02 no requiere una migración nueva.
- En PostgreSQL **15.20** pasaron las **6 pruebas dirigidas** tras la corrección, las **117 pruebas focalizadas** de créditos y sesiones y las **222 pruebas de Vitest** en la suite completa. Chromium pasó **37 casos** con la normativa anterior. El único caso omitido en esa ejecución, de créditos pendientes, pasó por separado con una versión sintética de la normativa revisada. TypeScript y `drizzle-kit check` pasaron. ESLint registró cero errores y tres avisos preexistentes.

### Incremento 10.4 — Revalidación de cuentas en cancelaciones

- [Integración PostgreSQL](../src/application/academic/cancellation-account.integration.test.ts). La prueba autentica una sesión sintética, bloquea la sesión académica desde otra conexión y observa las esperas con `pg_blocking_pids`. Con 10.3, las dos cancelaciones se confirmaron después de la baja. Con 10.4, si la baja gana, la solicitud espera por la cuenta y se rechaza tras la revocación, con reservas, ledger y auditoría de cancelación intactos.
- Si la cancelación gana, la baja espera por la cuenta. La prueba verifica una sola devolución en recuperación y una sola solicitud ordinaria pendiente con normativa revisada. El registro administrativo posterior de una ausencia resuelve ese crédito una vez. También se cubren reintentos tras la baja, titularidad, rol persistido, cancelación administrativa, cancelación global y reprogramación.
- Usar PostgreSQL 15 desechable con journal hasta `0013` y `TEST_DATABASE_URL` explícita. Ejecutar Vitest y Chromium en bases separadas. Los bloqueos de sincronización se revierten al cerrar cada prueba. El E2E de créditos pendientes requiere una versión normativa sintética vigente.
- En PostgreSQL **15.20** pasaron **8 pruebas dirigidas de H04**, **6 de H02**, **110 pruebas focalizadas** y **230 pruebas** en la suite completa de Vitest. Chromium pasó **37 casos** con la normativa anterior. El único caso omitido, de créditos pendientes, pasó por separado con la normativa sintética revisada. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes.

### Incremento 10.5 — Validación del inicio de sesión al reservar

- [PostgreSQL](../src/application/academic/reservation-admission.integration.test.ts). Una conexión separada bloquea el perfil. `pg_blocking_pids` confirma que la reserva espera antes del inicio y `pg_sleep_until` sincroniza la liberación del bloqueo con la hora real de inicio. En 10.4, la recuperación y las dos vías ordinarias se confirmaban en ese cruce. La genérica también aceptaba una sesión pasada con estado `SCHEDULED`.
- La integración comprueba reprogramaciones y cancelaciones concurrentes, igualdad y precisión de microsegundos con la hora repetida de Copenhague, reintentos válidos, ausencia de reservas o cargos tras un rechazo y conservación del aforo. Los casos de inscripción que antes simulaban el reloj de JavaScript ahora sitúan sus fixtures respecto al reloj de PostgreSQL y mantienen las mismas expectativas de rechazo.
- [Chromium administrativo](../tests/e2e/admin-session-enrollments.spec.ts) y [Chromium de créditos](../tests/e2e/credits.spec.ts) verifican que una página abierta antes del inicio comunica el rechazo y actualiza la disponibilidad sin mostrar éxito ni perder saldo.
- Usar bases PostgreSQL 15 desechables separadas para Vitest y Chromium, con journal hasta `0013` y `TEST_DATABASE_URL` explícita. El caso de créditos pendientes se verifica con una versión normativa sintética vigente.
- En PostgreSQL **15.20** pasaron **13 pruebas de H06**, incluidas en las **54 focalizadas**, además de **6 de H02**, **8 de H04** y las **243 de Vitest** en la suite completa. Chromium pasó **39 casos** con la normativa anterior. El único caso omitido, de créditos pendientes, pasó por separado con normativa sintética revisada. Pasaron TypeScript y `drizzle-kit check`. ESLint registró cero errores y tres avisos preexistentes.

### Incremento 10.6 — Aislamiento de pruebas PostgreSQL

- H08 eliminó el fallback de Playwright a DEV, los saltos de integración por ausencia de URL y la autorización de limpieza basada en el nombre de la base. Cada comando de escritura genera recursos y credenciales de corta duración y falla si no acredita su procedencia. Vitest y Chromium reciben identificadores, clústeres, puertos y bases independientes.
- La limpieza de fixtures se limita a la base Vitest verificada y preserva el marcador y el journal. Tras éxito, fallo o una señal gestionada, el aprovisionador comprueba la propiedad y detiene únicamente su contenedor. Docker elimina su almacenamiento temporal. Una terminación forzada del proceso o la pérdida del daemon puede impedir la limpieza automática. El prefijo y la identificación de ejecución permiten localizar el recurso restante para revisión.
- La protección presupone un daemon Docker de confianza y permisos adecuados en el entorno de ejecución. El rol de la suite se crea solo en la instancia desechable. Las conexiones manuales que se hagan fuera de estos comandos siguen bajo los permisos del operador. [Diseño](architecture.md#aislamiento-de-pruebas-postgresql)
- Las pruebas negativas usan configuraciones y conexiones sintéticas para verificar el rechazo de DEV, TEST persistente, producción, marcadores inválidos y recursos ajenos o vencidos. También comprueban migración y limpieza sin verificación, integración directa sin URL y un servidor HTTP preexistente. La integración positiva coteja cada hash del journal, los permisos del rol y la limpieza de una fixture sin tocar el marcador.
- Pasaron **86 unitarias** sin PostgreSQL, **185 integraciones** y **271 pruebas** en Vitest completo. `npm run test:verify` pasó además **39 E2E de Chromium** y **1 E2E de créditos pendientes** en una instancia separada con normativa sintética. Se comprobó la retirada exclusiva del contenedor tras un fallo y tras una interrupción gestionada. Pasaron TypeScript, ESLint y `drizzle-kit check`.

### Incremento 10.7 — Presupuesto compartido de login

- Las unitarias comprueban las claves HMAC, los límites y la configuración inválida, el rechazo temprano de entradas, el uso de bcrypt ficticio, las respuestas de la acción y el fallo seguro antes de consultar credenciales. El aprovisionador entrega un secreto aleatorio y una política fija de prueba a cada ejecución desechable.
- PostgreSQL verifica el umbral exacto, el presupuesto general, la expiración y limpieza, la ausencia de escrituras parciales, el acceso con credenciales válidas y la revocación. Comprueba que devolver una oportunidad conserva los demás intentos y la ventana vigente. Una prueba ejecuta el mismo limitador en el proceso de Vitest y en dos procesos de aplicación sucesivos, cada uno con su propia conexión verificada. Otra mantiene el bloqueo de admisión ocupado y observa dos conexiones esperando en `pg_stat_activity` antes de liberar la última oportunidad. La prueba de baja observa la espera de emisión de sesión sobre la fila de usuario antes de confirmar la baja.
- Chromium comprueba la respuesta idéntica para credenciales incorrectas, correo desconocido y cuenta desactivada. Cambia las cabeceras entre intentos, comprueba el límite y vuelve a iniciar sesión después de que la ventana venza. Para evitar esperar 15 minutos, la fixture acorta únicamente el vencimiento de su identidad sintética en la base verificada y espera que PostgreSQL marque la ventana como vencida. También se cubren el acceso por teclado a 360 px, el cierre y la revocación de sesión y el cambio administrativo del correo.
- La migración 0014 se aplica desde el aprovisionador del incremento 10.6. Para repetir las integraciones focalizadas, usa `npm run test:integration -- login.integration.test.ts academic.integration.test.ts student-edit.integration.test.ts`. Para Chromium, usa `npm run test:e2e -- auth-guards.spec.ts admin-student-edit.spec.ts student-accounts.spec.ts student-withdrawal.spec.ts`. [Política de login](authentication.md#limitación-de-intentos-de-login)
- Pasaron 30 integraciones y 13 escenarios Chromium focalizados. `npm run test:verify` pasó las 306 pruebas de Vitest (111 unitarias y 195 integraciones), los 43 escenarios Chromium y el escenario adicional con normativa sintética en otra instancia. También pasaron TypeScript, ESLint y `drizzle-kit check`.

### Incremento 10.8 — Ensayo de actualización y recuperación PostgreSQL

- `npm run db:rehearse` ejecuta los ensayos H07, también incluidos en `npm run test:verify`. El PostgreSQL Vitest migrado desde vacío sirve como referencia final. El mismo aprovisionador crea clústeres independientes para los prefijos, las dos actualizaciones y la restauración.
- Los recorridos comparan valores de cuentas, perfiles, sesiones, reservas, asistencia, cancelaciones, normativa, auditoría y ledger. Comprueban el saldo y consumo de la fixture, relaciones, idempotencia, el presupuesto compartido de login y la ausencia de publicación automática. Un error sintético de restricción revierte el lote de migraciones y conserva el estado anterior.
- El ensayo valida el formato personalizado, SHA-256, contenido del TOC y restauración completa. Rechaza el archivo truncado, un destino persistente, un destino de restauración ya ocupado, la deriva de catálogo y una configuración de arranque incompatible. La inspección de DEV y TEST persistente solo accede a identidad, catálogo y journal. [Inventario y procedimiento](postgres-upgrade-recovery.md)
- Pasaron los cuatro ensayos de H07 y la verificación completa con 310 pruebas Vitest, 43 escenarios Chromium y uno adicional con normativa sintética. También pasaron TypeScript, ESLint y `drizzle-kit check`.

### Incremento 10.9 — Conciliación transaccional y lecturas de créditos

- La reproducción dirigida bloqueó la segunda plantilla desde una conexión independiente y observó al CLI esperando mediante `pg_blocking_pids`. En la versión anterior, al pedir el perfil desde esa conexión PostgreSQL abortó el CLI mientras esperaba el bloqueo asesor. Una segunda reproducción con las mismas operaciones SQL capturó `40P01`. Con el orden nuevo, la conexión pudo tomar el perfil y el CLI terminó tras liberarlo. La prueba también cruza el fin real de la asignación con el CLI y fuerza un fallo en otra plantilla para verificar el rollback del comando completo.
- Las integraciones comprueban el acortamiento con fecha final inclusiva, la ampliación con asistencia, el alta retroactiva con ausencia, el rollback de la asignación si falla el ledger y la conservación de decisiones previas. Otras pruebas observan esperas entre dos asignaciones, el alta y una cancelación global o reprogramación, y el fin frente a la baja o a un ajuste vinculado.
- Las consultas de saldo y disponibilidad se ejecutan en PostgreSQL en modo de solo lectura. Las pruebas comparan el ledger antes y después de lecturas repetidas, incluida la navegación de alumno y administrador en Chromium. El ensayo de pendientes anteriores llama dos veces al conciliador en una transacción sintética y la revierte. Luego comprueba que una reserva real consume el crédito concedido y que su reenvío conserva el movimiento inicial.
- La verificación cubre los escenarios de espera reproducidos. El CLI conserva hasta el commit los bloqueos sobre las plantillas de su ejecución. La regularización histórica requiere autorización expresa. [Inventario y procedimiento](academic-model.md#inventario-de-solicitudes-anteriores-a-h09)
- `npm run test:verify` pasó 322 pruebas Vitest, 43 escenarios Chromium y un escenario Chromium adicional con normativa sintética, en instancias PostgreSQL 15 desechables de H08. Pasaron TypeScript, ESLint y `drizzle-kit check`. El journal sigue en `0014`.

### Incremento 10.10 — Navegación, móvil y teclado

- Se revisaron el acceso y cierre de sesión, el calendario y las próximas clases, los créditos, las solicitudes pendientes, la reserva y cancelación de recuperaciones y el historial del alumno. En administración se revisaron el panel, los alumnos y sus perfiles, la edición y auditoría, movimientos y ajustes de créditos, y el calendario y detalle de sesión con asistencia, aforo, inscripciones y cancelaciones. El calendario y la sección de perfiles son los listados disponibles en el panel.
- P1 de móvil. Chromium midió 817 px de exceso horizontal en el panel administrativo a 320 px con un nombre largo. El layout carga ahora la hoja común. Los formularios se ajustan al ancho disponible y los nombres y correos pueden ocupar varias líneas. La presentación conserva los controles nativos.
- P1. Se añadió un salto al contenido, accesos directos por rol y foco visible. El filtro de créditos conserva la semana y enfoca la sección correspondiente. La edición devuelve el foco al enlace de origen al cancelar y señala el primer campo con error. La paginación de recuperaciones lleva el foco a la primera clase añadida, y las confirmaciones de las operaciones revisadas se anuncian en el panel. Los desplegables de cancelación y asistencia usan `details` nativo.
- Las pruebas Chromium ejercitan los paneles y los detalles administrativos a 320, 360, 390, 768 y 1280 px. Comprueban el orden de tabulación, Enter, Space, foco en mensajes y campos, estados vacíos, límites de rol, enlaces de retorno con contexto, paginación y una recuperación confirmada.
- Pasaron 27 escenarios Chromium focalizados. Para repetir las dos regresiones nuevas, ejecutar `npm run test:e2e -- portal-navigation.spec.ts`. Las capturas temporales de ambos paneles permitieron comprobar la distribución de enlaces, los saltos de línea y la visibilidad de los controles.
- `npm run test:verify` completó 322 pruebas Vitest, 45 escenarios Chromium y un escenario adicional con normativa sintética mediante H08. Se repitió la suite completa después de un fallo de manifiesto durante una recarga de Next dev. Pasaron TypeScript, ESLint y `drizzle-kit check`. El journal sigue en `0014`.
- P2. Unificar la presentación de horas y cantidades en las listas de saldo e historial y revisar los textos de opciones extensas. La revisión se limita a Chromium y a los recorridos indicados. Sigue pendiente la validación manual con tecnologías de asistencia en varios navegadores.

### Incremento 10.11 — Fechas, horas y créditos en los historiales

- Los portales de alumno y administración, el perfil administrativo y el detalle de sesión comparten los formatos de historiales, auditoría, reservas, recuperaciones y créditos. Las vigencias de tipo PostgreSQL `DATE` muestran `dd/mm/aaaa` conservando su día. Los instantes muestran la fecha y hora de `Europe/Copenhagen` en español, con desplazamiento GMT para distinguir la hora repetida de otoño. El atributo `datetime` mantiene el valor ISO completo.
- Las cantidades usan singular y plural. El tipo de movimiento identifica su sentido con una etiqueta y un signo. Las devoluciones sin abono confirmado mantienen su cantidad registrada sin aparentar un aumento del saldo. El saldo disponible y las solicitudes pendientes se muestran por separado. Se conservan los cálculos, los parámetros de navegación y las consultas de solo lectura.
- Las 19 pruebas unitarias cubren fechas inválidas y ausentes, cambios de mes y año, medianoche, ambos cambios de hora y los tipos de movimiento. La revisión focalizada ejercitó 30 escenarios Chromium. Dos aserciones se ajustaron a la representación de `datetime` y al texto localizado y pasaron en la repetición dirigida.
- El caso de ambos paneles usa un navegador con zona `Pacific/Honolulu`, compara el HTML inicial con el texto del navegador y verifica los dos desplazamientos de otoño a 320 y 360 px. Comprueba también que el ledger persista intacto tras las lecturas. El texto muestra precisión hasta el minuto y las pruebas de navegador se concentran en Chromium.
- `npm run test:verify` pasó 341 pruebas Vitest, 46 escenarios Chromium y un escenario adicional con normativa sintética, con PostgreSQL desechable mediante H08. Pasaron TypeScript, ESLint y `drizzle-kit check`. El journal sigue en `0014`.

### Incremento 10.12 — Accesibilidad de fechas, movimientos y solicitudes pendientes

- Los historiales de ambos roles mantienen las fechas y cantidades visibles del 10.11. Cada `time` conserva su `datetime`. En el árbol accesible, una fecha de calendario usa el nombre del mes y los instantes de Copenhague expresan los desplazamientos como «GMT más 2 horas» o «GMT más 1 hora». Cada fecha y movimiento aporta una sola representación a ese árbol.
- Los movimientos expresan «más» y «menos» junto al tipo y la cantidad. Las devoluciones sin abono conservan esa distinción. El historial del alumno identifica las solicitudes pendientes, muestra su fecha original desde la cancelación ya consultada y explica que quedan fuera del saldo hasta resolverse. La consulta del historial sigue siendo de solo lectura.
- Se verificaron encabezados, regiones, listas y paginaciones. Los historiales del alcance usan listas nativas. El perfil administrativo identifica la página actual con `aria-current="page"`. Playwright comprobó ambos desplazamientos de otoño, fechas sin hora, movimientos, saldo, persistencia intacta, foco y ausencia de desbordamiento a 320 y 360 px. Pasaron 22 unitarias focalizadas, 28 escenarios Chromium focalizados y el escenario separado con normativa sintética.
- `npm run test:verify` pasó 344 pruebas Vitest, 46 escenarios Chromium y un escenario adicional con normativa sintética mediante H08. Pasaron TypeScript, ESLint y `drizzle-kit check`. El journal sigue en `0014`.

#### Comprobación manual de pronunciación pendiente

En un equipo Windows con NVDA, inicia Chromium con el Inspector de Playwright. Avanza hasta el punto indicado y deja el caso detenido mientras recorres la pantalla con los comandos de lectura de NVDA y Tab para los enlaces. Los comandos aprovisionan datos sintéticos mediante H08.

| Comando | Qué escuchar |
| --- | --- |
| `npm run test:e2e -- history-format.spec.ts --debug` | En el historial de movimientos del alumno, distingue las dos apariciones de las 02:30 y sus desplazamientos. En horarios habituales, comprueba una fecha de calendario. Escucha también el saldo. |
| `npm run test:e2e -- credits.spec.ts student-credit-expirations.spec.ts --debug --grep "earns one credit\|single refund\|only available credit expirations"` | Después de reservar o cancelar la recuperación, escucha concesión, consumo, devolución y caducidad. Comprueba el sentido de cada movimiento y que el signo y la cantidad se anuncien una sola vez. |
| `npm run test:e2e:pending -- credits.spec.ts --debug` | Después de cancelar la clase y antes de registrar la ausencia anterior, escucha «solicitud pendiente», su fecha original y el saldo disponible por separado. |
| `npm run test:e2e -- admin-student-edit.spec.ts --debug --grep "pages the audit"` | Recorre el encabezado, los elementos de la lista de auditoría, un enlace de paginación y la indicación de página actual. |

La comprobación de este incremento se realizó con Playwright en Chromium. La pronunciación con un lector real y la comprobación complementaria con Firefox quedan pendientes.

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
| ATTEND-001 | Corrección de asistencia conserva trazabilidad y un único resultado vigente | Integración | `src/application/academic/attendance.integration.test.ts` | Ejecutada correctamente en PostgreSQL TEST aislado | `npm run test -- src/application/academic/attendance.integration.test.ts` |
| ABSENCE-001 | Detección de ausencias idempotente y sin dependencia UUID extension | Integración | `src/application/academic/academic.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/academic/academic.integration.test.ts` |
| HABITUAL-001 | Asignación habitual reserva sesiones futuras, evita duplicados y respeta capacidad | Integración | `src/application/academic/habitual-assignment.integration.test.ts` | Ejecutada correctamente | `npm run test -- src/application/academic/habitual-assignment.integration.test.ts` |
| LEDGER-INT-001 | Integridad ledger: detección de consumos/devoluciones huérfanos y auditoría manual incompleta | Integración | `src/application/credits/credit-service.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/credits/credit-service.integration.test.ts` |
| LOCK-CROSS-001 | Cruce reserva de recuperación vs cancelación administrativa sin estado imposible | Integración | `src/application/recovery/recovery.integration.test.ts` | Pendiente de infraestructura | `npm run test -- src/application/recovery/recovery.integration.test.ts` |
| E2E-AUTH-001 | Guardas de autenticación y rutas protegidas | E2E | `tests/e2e/auth-guards.spec.ts` | Ejecutada correctamente | `npm run test:e2e` |
| E2E-BASE-001 | Carga página inicial | E2E | `tests/e2e/home.spec.ts` | Ejecutada correctamente | `npm run test:e2e` |
| E2E-CRED-001 | Cancelación habitual, crédito, reserva de recuperación y saldo actualizado desde el panel | E2E | `tests/e2e/credits.spec.ts` | Ejecutada correctamente en Chromium con PostgreSQL TEST aislado | `npm run test:e2e -- tests/e2e/credits.spec.ts` con `TEST_DATABASE_URL` |

## Incremento 10.15 — Vigencia de asignaciones habituales

La reproducción previa a la corrección, ejecutada mediante H08, confirmó que una asignación futura con inicio el 5 de abril aceptaba el 4 de abril como fin. La transacción guardaba el intervalo invertido, resolvía la solicitud pendiente y añadía una concesión al ledger. La regresión comprueba que el rechazo conserva la fila, la solicitud y el ledger, que dos cambios concurrentes de la misma asignación solo permiten el válido y que un rechazo posterior conserva la concesión consolidada.

Las 35 pruebas focalizadas de normativa y generación pasaron en PostgreSQL 15 desechable. Cubren el fin inclusivo, la fecha por omisión, fechas inexistentes, permisos, cruces de mes, año y horario de verano en Copenhague, además del rollback y la concurrencia de H09. La regresión verifica con `pg_blocking_pids` que la solicitud inválida espera el bloqueo de plantilla y comprueba el rechazo al liberarlo. La acción de servidor existente exige el rol administrativo. La interfaz actual carece de formulario de finalización, por lo que no hay un campo visible al que asociar el error.

Una futura restricción de tabla protegería también otras escrituras, con `effective_to IS NULL OR effective_to >= effective_from`. Requiere inventariar filas históricas, revisar la baja de cuenta (que puede cerrar una asignación futura con la fecha de baja) y ensayar una migración aditiva mediante H07. El esquema sigue en `0014`. La consulta de diagnóstico para un operador autorizado es de solo lectura. No se ejecutó en bases persistentes.

```sql
BEGIN READ ONLY;
SELECT count(*) AS invalid_assignment_count
FROM student_template_assignments
WHERE effective_to < effective_from;
COMMIT;
```

`npm run test:verify` pasó con 348 pruebas Vitest, 46 casos Chromium y un caso Chromium con normativa sintética. Se repitieron las pruebas focalizadas tras añadir la comprobación explícita de espera, sin cambios adicionales al código de producción. También pasaron TypeScript, ESLint y Drizzle.

## Incremento 10.17 — Anulación explícita de asignaciones futuras

La regresión `assignment-cancellation.integration.test.ts` cubre permisos, motivo, fechas conservadas, auditoría, reservas ambiguas, idempotencia concurrente, rechazo de asignaciones iniciadas, finalización de una anulada y baja con varias asignaciones. Comprueba que no se crean reservas, cancelaciones ni movimientos de crédito, y que `effective_to < effective_from` queda en cero. La prueba existente de baja se actualizó para distinguir `ENDED` de `CANCELLED` y para leer la nueva auditoría. La generación añade un caso que demuestra que una asignación anulada no recibe plaza.

- Ejecutar `npm run test:integration -- assignment-cancellation.integration.test.ts session-generation.integration.test.ts academic.integration.test.ts` y después la suite completa con `npm run test:integration`.
- Las pruebas usan exclusivamente PostgreSQL 15 desechable de H08. La migración `0015_future_assignment_cancellation` se aplica desde el aprovisionador; no se ejecutó en DEV, TEST persistente ni producción.
- `scripts/db-schema-fingerprints.json` incorpora la huella del journal hasta `0015`. El ensayo H07 verifica todos los prefijos, la actualización desde `0005`/`0006`, la restauración y la detección de deriva.
- Pasaron **356 pruebas Vitest** (133 unitarias y 223 integraciones), **46 escenarios Chromium** y **1 escenario Chromium adicional** con normativa sintética mediante H08. También pasaron TypeScript, ESLint y `drizzle-kit check`.
- La consulta de diagnóstico de intervalos históricos del 10.15 sigue siendo de solo lectura. No se corrigieron filas anteriores ni se añadió una restricción de tabla.

## Incremento 10.18 — Interfaz administrativa para anular asignaciones futuras

La ficha administrativa ofrece «Anular asignación futura» cuando la cuenta está activa, la asignación sigue `ACTIVE` y su inicio persistido es posterior al día local de Copenhague. La confirmación muestra alumno, curso, fechas originales, la advertencia sobre reservas y un motivo obligatorio de 3 a 300 caracteres. La Server Action exige `SUPER_ADMIN`, rechaza campos ajenos al motivo y delega en `cancelFutureAssignment`, sin duplicar fechas, bloqueos ni auditoría. La revalidación actualiza la ficha, el panel y el área del alumno.

La auditoría se muestra en la misma fila con origen `ADMIN_INDIVIDUAL` o `STUDENT_WITHDRAWAL`, actor, instante y motivo. Una reserva ambigua se resume por cantidad y no se presenta como reserva cancelada. La anulación individual no modifica reservas, no libera plazas, no mueve créditos y no crea una segunda auditoría. La generación posterior sigue cubierta por la regresión de 10.17.

- `tests/e2e/admin-assignment-cancellation.spec.ts` cubre el recorrido completo en Chromium: condiciones de la acción, confirmación, advertencia, motivo vacío y demasiado corto, rechazo de campos manipulados, anulación válida, fechas conservadas, etiqueta, desaparición de la acción, auditoría única, reserva ambigua confirmada, aforo sin liberar, reintento idempotente desde una pestaña desactualizada, foco, teclado y presentación a 320/360 px. Otro escenario comprueba que un alumno y un visitante anónimo no acceden a la operación.
- `admin-student-profile.integration.test.ts` incorpora la lectura del inicio persistido y de la auditoría de ambas fuentes sin escrituras durante la carga.
- Ejecutar `npm run test:e2e -- tests/e2e/admin-assignment-cancellation.spec.ts` y `npm run test:integration -- admin-student-profile.integration.test.ts`. Después, la verificación completa con `npm run test:verify`.
- Las pruebas usan exclusivamente PostgreSQL 15 desechable de H08. No se añadió una migración ni se modificó el esquema `0015`. No se ejecutaron migraciones en DEV, TEST persistente ni producción.
- Queda pendiente registrar la procedencia de las reservas habituales para poder cancelarlas de forma inequívoca y el inventario de intervalos históricos. La interfaz no afirma que todas las reservas relacionadas puedan identificarse.
- Pasaron **357 pruebas Vitest** (133 unitarias y 224 integraciones), **48 escenarios Chromium** y **1 escenario Chromium adicional** con normativa sintética mediante H08. También pasaron TypeScript, ESLint y `drizzle-kit check`.

## Incremento 10.19 — Enlaces administrativos para revisar reservas ambiguas

La ficha administrativa enumera las reservas que la auditoría de anulación marcó como ambiguas y las enlaza con su sesión actual. La consulta forma parte de la instantánea de solo lectura, recoge los identificadores únicos de todas las anulaciones de la página y los lee en bloque filtrando por el perfil solicitado. No hay consultas por fila ni escrituras durante la carga.

El estado que exige revisión se deriva de los datos persistidos: reserva `CONFIRMED`, sesión `SCHEDULED` y fin posterior al instante de la consulta. Una reserva cancelada, una sesión cancelada o una sesión terminada dejan de contarse sin modificar la auditoría. Un identificador ausente, ajeno o ilegible se muestra como «Registro no localizado». El enlace conserva la semana de la sesión y exige `SUPER_ADMIN` en la página de destino. Una baja de cuenta conserva la auditoría y no genera pendientes si sus reservas futuras ya fueron canceladas.

- `admin-student-profile.integration.test.ts` añade tres pruebas: la lista solo incluye reservas del perfil solicitado aunque la auditoría contenga identificadores ajenos; el estado vigente distingue confirmada, cancelada y sesión terminada sin alterar la auditoría; y una reserva cancelada o una sesión pasada dejan de requerir revisión. La expectativa de la baja comprueba que una anulación por baja sin reservas señaladas expone una lista vigente vacía. Las pruebas verifican que la carga no crea reservas, cancelaciones ni movimientos de crédito.
- `tests/e2e/admin-assignment-cancellation.spec.ts` amplía el recorrido de anulación con la sección, la advertencia, los dos recuentos, la fecha actual de la sesión, el enlace con semana y la ausencia de desbordamiento horizontal a 320 y 360 px. El escenario nuevo abre dos reservas señaladas, comprueba el foco y la navegación por teclado a la sesión, vuelve a la ficha y cancela una reserva en la base de datos para verificar que el recuento vigente baja sin cambiar la auditoría. El escenario de alumno y visitante anónimo comprueba que la sección no se muestra.
- Ejecutar `npm run test:integration -- admin-student-profile.integration.test.ts` y `npm run test:e2e -- tests/e2e/admin-assignment-cancellation.spec.ts`. Después, la verificación completa con `npm run test:verify`.
- Las pruebas usan exclusivamente PostgreSQL 15 desechable de H08. No se añadió una migración ni se modificó el esquema `0015`. No se ejecutaron migraciones en DEV, TEST persistente ni producción.
- Pasaron **360 pruebas Vitest** (133 unitarias y 227 integraciones), **49 escenarios Chromium** y **1 escenario Chromium adicional** con normativa sintética mediante H08. También pasaron TypeScript, ESLint y `drizzle-kit check`.
- Sigue pendiente registrar la procedencia de las reservas habituales, el saneamiento de intervalos históricos y el inventario de reservas antiguas. La lista muestra únicamente los identificadores que la auditoría ya conservaba y no deduce reservas nuevas.

## Incremento 10.20 — Procedencia de reservas habituales

La migración aditiva `0016_habitual_reservation_provenance` añade `class_reservations.habitual_assignment_id`, una referencia anulable a `student_template_assignments` con `ON DELETE SET NULL`, y el índice `class_reservations_habitual_assignment_idx`. No rellena filas existentes.

El alta de una asignación escribe su identificador en las reservas automáticas que crea. La generación conserva la asignación solo cuando exactamente una asignación no anulada, vigente y de una cuenta activa cubre la sesión; con dos o más coincidencias la reserva se crea sin referencia. La cancelación de la reserva mantiene la columna. El 10.21 usa esta referencia para anular reservas futuras.

- `habitual-provenance.integration.test.ts` añade cinco pruebas: la reserva generada registra la asignación; la cancelación conserva la referencia; la inscripción administrativa queda sin procedencia; dos asignaciones solapadas generan reservas sin referencia; y borrar la asignación deja la reserva con la columna vacía.
- `session-generation.integration.test.ts` selecciona la columna en su lector de reservas y comprueba la asignación del alta, el caso ambiguo de dos asignaciones vigentes, el rechazo de una asignación anulada y la reserva única del cruce entre CLI, aplicación y alta concurrente.
- `postgres-rehearsal.integration.test.ts` verifica que la columna es anulable y que el ensayo H07 conserva los prefijos y detecta la deriva con la nueva huella.
- Ejecutar `npm run test:integration -- habitual-provenance.integration.test.ts session-generation.integration.test.ts habitual-assignment.integration.test.ts` y después la verificación completa con `npm run test:verify`.
- Las pruebas usan exclusivamente PostgreSQL 15 desechable de H08. La migración `0016_habitual_reservation_provenance` se aplica desde el aprovisionador; no se ejecutó en DEV, TEST persistente ni producción.
- `scripts/db-schema-fingerprints.json` incorpora la huella del journal hasta `0016`. El ensayo H07 verifica todos los prefijos, la actualización desde `0005`/`0006`, la restauración y la detección de deriva.
- Pasaron **365 pruebas Vitest** (133 unitarias y 232 integraciones), **49 escenarios Chromium** y **1 escenario Chromium adicional** con normativa sintética mediante H08. También pasaron TypeScript, ESLint y `drizzle-kit check`.
- Las pruebas de concurrencia no registraron `40P01`. Siguen pendientes el saneamiento de intervalos históricos, el inventario de reservas anteriores sin procedencia y el uso de la columna para cancelar reservas de forma automática.

## Incremento 10.21 — Cancelación de reservas vinculadas al anular asignaciones

La anulación individual de una asignación futura cancela en la misma transacción las reservas `CONFIRMED` de sesiones futuras cuyo `habitual_assignment_id` coincide con la asignación. La selección excluye reservas de otro alumno, de otra plantilla, ya canceladas, de sesiones iniciadas, fuera de la vigencia y las que otra asignación viva del mismo curso cubre en la fecha de la sesión. En 10.21 la procedencia explícita prevalecía sobre el origen, por lo que una recuperación vinculada también se cancelaba; el 10.22 restringe la cancelación a `ORDINARY` y conserva las recuperaciones. Las reservas `ORDINARY` candidatas sin referencia se conservan y se registran como ambiguas; las cubiertas por otra asignación viva se conservan sin señalarse. La operación no modifica `max_capacity`, no crea solicitudes ni movimientos de crédito y no escribe en `reservation_cancellations`.

`assignment-cancellation.integration.test.ts` añade cinco pruebas: solo se cancelan las reservas futuras vinculadas y las candidatas no atribuibles se clasifican como ambiguas; el reintento reutiliza los identificadores auditados; un fallo sintético de auditoría revierte el estado de la asignación y las reservas; la anulación concurrente con la generación no pierde reservas; y la concurrencia con la baja no produce `40P01` ni una auditoría duplicada. Las pruebas comprueban que las reservas canceladas conservan su procedencia y que no aparecen movimientos de crédito ni cambios de `max_capacity`. La prueba de rollback parte de una asignación `ACTIVE` y verifica que vuelve a `ACTIVE` con la reserva `CONFIRMED`.

`admin-student-profile.integration.test.ts` añade una prueba que distingue la reserva vinculada cancelada de la reserva ambigua revisada, y comprueba que la ficha lee el recuento `cancelledReservationIds` sin escrituras. `tests/e2e/admin-assignment-cancellation.spec.ts` añade un escenario con dos reservas vinculadas y una ambigua: confirma los dos recuentos, el foco del estado, la auditoría, la cancelación de las dos reservas, la conservación de la ambigua, la ausencia de desbordamiento a 320/360 px y la repetición desde una pestaña desactualizada con los recuentos auditados.

- Ejecutar `npm run test:integration -- assignment-cancellation.integration.test.ts admin-student-profile.integration.test.ts` y `npm run test:e2e -- tests/e2e/admin-assignment-cancellation.spec.ts`. Después, la verificación completa con `npm run test:verify`.
- Las pruebas usan exclusivamente PostgreSQL 15 desechable de H08. No se añadió una migración ni se modificó el esquema `0016`. No se ejecutaron migraciones en DEV, TEST persistente ni producción.
- Pasaron **371 pruebas Vitest** (133 unitarias y 238 integraciones), **50 escenarios Chromium** y **1 escenario Chromium adicional** con normativa sintética mediante H08. También pasaron TypeScript, ESLint y `drizzle-kit check`.
- Las pruebas de concurrencia no registraron `40P01`. Siguen pendientes el saneamiento de intervalos históricos y el inventario de reservas anteriores sin procedencia.

## Incremento 10.22 — Preservación de recuperaciones en la anulación habitual

La anulación individual restringe la cancelación automática a reservas `ORDINARY` futuras, confirmadas, vinculadas a la asignación y sin otra asignación viva que cubra la fecha. Las recuperaciones (`MAKEUP`) se conservan siempre: mantienen su estado confirmado, su plaza y el movimiento `RECOVERY_CONSUMPTION`. Una recuperación vinculada de forma anómala se registra en `ambiguous_reservation_ids` junto con las reservas `ORDINARY` sin procedencia, de modo que la revisión administrativa nunca elimina un consumo de crédito válido. La interfaz administrativa distingue las reservas habituales canceladas de las conservadas para revisión y explica por fila si se trata de una recuperación protegida o de una reserva ordinaria sin procedencia demostrable.

`assignment-cancellation.integration.test.ts` amplía el caso de reservas vinculadas con una recuperación `MAKEUP` del mismo alumno y plantilla: solo se cancela la `ORDINARY`, la recuperación conserva estado, plaza y ledger, y la auditoría separa canceladas de conservadas. Añade pruebas para la ruta legítima de recuperación (que persiste `origin = MAKEUP` y `habitual_assignment_id` vacío, por lo que no requiere revisión), para una recuperación vinculada sintéticamente (se señala y no se cancela), para la ausencia de reservas vivas duplicadas tras una generación posterior y para la concurrencia con una reserva de recuperación, que no produce `40P01` ni cancela la recuperación.

`admin-student-profile.integration.test.ts` comprueba que la ficha enumera la recuperación conservada como parte de la revisión, que la reserva vinculada `ORDINARY` figura como cancelada y que ambos recuentos derivan de la auditoría sin escrituras. `tests/e2e/admin-assignment-cancellation.spec.ts` añade una recuperación vinculada al escenario de dos reservas: confirma que solo se cancelan las dos `ORDINARY`, que la recuperación sigue confirmada, que la ficha muestra el aviso de recuperación protegida y que los recuentos auditados se repiten en el reintento.

- Pasaron **374 pruebas Vitest** (133 unitarias y 241 integraciones), **50 escenarios Chromium** y **1 escenario Chromium adicional** con normativa sintética mediante H08. También pasaron TypeScript, ESLint y `drizzle-kit check`.
- Ejecutar `npm run test:integration -- assignment-cancellation.integration.test.ts admin-student-profile.integration.test.ts` y `npm run test:e2e -- tests/e2e/admin-assignment-cancellation.spec.ts`. Después, la verificación completa con `npm run test:verify`.
- Las pruebas usan exclusivamente PostgreSQL 15 desechable de H08. No se añadió una migración ni se modificó el esquema `0016`. No se ejecutaron migraciones en DEV, TEST persistente ni producción.
- Las pruebas de concurrencia no registraron `40P01`.

## Incremento 10.23 — Aforo físico y plazas reservables en las consultas de disponibilidad

R14-02 señalaba que las dos consultas de solo lectura de aforo podían informar plazas libres en sesiones cerradas. El incremento conserva las consultas y aclara su contrato: `calculateReservableSpots` devuelve cero salvo en sesiones `UPCOMING` y `getClassSessionAvailability` / `getRecoveryAvailabilityForSession` publican a la vez el aforo físico, el aforo efectivo, los compromisos, las plazas físicamente libres y las plazas reservables, junto con el estado de sesión y sus horas. El calendario y el detalle administrativo reutilizan el mismo predicado. No cambian la admisión, la revalidación ni la normativa, y no se añadió migración.

`session-availability.integration.test.ts` es nueva y cubre, sobre PostgreSQL 15 desechable: el contrato completo de una sesión futura; plazas físicamente libres positivas con cero reservables en sesiones en curso, finalizadas por hora, marcadas como completadas o canceladas; el recuento de solo reservas confirmadas y bloqueos activos; la aplicación del límite de normativa al aforo efectivo sin alterar el físico; la coherencia de la consulta de recuperación con créditos y cupo mensual, incluida la última plaza; el rechazo de la mutación tras una lectura favorable o sobre una sesión cerrada; la ausencia de escrituras en sesiones, reservas, bloqueos y ledger; y los errores de permisos y de sesión inexistente. `availability.test.ts` añade casos unitarios de `calculateReservableSpots` y `regulation.integration.test.ts` verifica que una reducción de aforo deja las plazas reservables en cero conservando el aforo físico.

- Ejecutar `npm run test:integration -- session-availability.integration.test.ts availability.test.ts` y `npm run test:unit -- availability.test.ts`. Después, la verificación completa con `npm run test:verify`.
- Pasaron **385 pruebas Vitest** (136 unitarias y 249 integraciones), **50 escenarios Chromium** y **1 escenario Chromium adicional** con normativa sintética mediante H08. También pasaron TypeScript, ESLint y `drizzle-kit check`.
- Las pruebas usan exclusivamente PostgreSQL 15 desechable de H08. No se añadió una migración ni se modificó el esquema `0016`. Los errores de permisos, sesión inexistente y la ausencia de escrituras se comprueban en la nueva suite; la concurrencia no cambió y no se registraron `40P01`.

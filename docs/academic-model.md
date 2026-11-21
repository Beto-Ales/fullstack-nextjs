# Modelo académico (Prompt 06)

## Modelo de cursos confirmado

- `SUPER_ADMIN` puede crear un curso con una sesión semanal durante tres meses o un curso de una sola sesión en una fecha concreta. Cada curso admite como máximo 12 alumnos inscritos.
- Anular la reserva habitual de un alumno libera la plaza de esa fecha. Las reservas de las demás fechas y la asignación al curso se conservan.
- Un alumno elegible puede reservar una recuperación en otra clase futura programada. Al confirmar se cuentan las reservas confirmadas y los bloqueos activos y se comprueba el aforo antes de consumir el crédito en la misma transacción.

### Estado funcional

- El panel de administración permite crear cursos semanales y clases únicas, e inscribir alumnos de forma ordinaria en ambos. La clase única se guarda como sesión independiente con `template_id` vacío. En el curso semanal se crea una asignación a la plantilla y se reservan las sesiones futuras elegibles con plazas libres.
- La reserva de una sesión aplica el menor de su capacidad y el límite de la normativa vigente bajo bloqueo de fila. La asignación a la plantilla limita a 12 alumnos distintos simultáneos durante la vigencia. La comprobación y el alta comparten el bloqueo por plantilla que usa el generador. Se comprueba también la coincidencia con altas futuras.
- El alta, la baja lógica y el cambio de contraseña propia están disponibles en los paneles correspondientes. El límite de 12 alumnos simultáneos se aplica al inscribir en cursos nuevos, también ante altas concurrentes. [Permisos de fase 06](authentication.md#permisos-confirmados-de-fase-06).

### Baja definitiva y plazas

- La baja es lógica y conserva la cuenta, el historial y las relaciones académicas. Desde que se hace efectiva termina la inscripción y se liberan tanto las plazas ordinarias como las de recuperaciones confirmadas de clases que aún no han empezado. Las reservas de los demás alumnos y los bloqueos se conservan.
- El administrador decide si incorpora un sustituto para las fechas restantes o deja las plazas disponibles para recuperaciones.
- El flujo de `/admin` termina las inscripciones abiertas y las programadas que aún no han vencido. Conserva la fecha local de baja como límite de las inscripciones. La hora de baja decide qué reservas son futuras, incluidas las de más tarde ese día. Desde la baja el alumno deja de computar para nuevas inscripciones y el generador no le reserva plazas. La liberación conserva los registros de reserva y de créditos. [Baja de alumnos](authentication.md#baja-de-alumnos).
- `student_withdrawals` registra el administrador, el alumno, la fecha y hora, las inscripciones terminadas, las reservas ordinarias liberadas y cada recuperación cancelada, con el resultado de devolución y restauración de saldo. La baja, las devoluciones y la auditoría comparten transacción. Un reintento conserva el registro original.
- Para cada recuperación se aplica la antelación de la versión vigente al dar de baja. Si la cancelación es tardía, se libera la plaza y se conserva el consumo. Si se cancela a tiempo, se registra la devolución vinculada al consumo y a la concesión. El saldo solo se restaura si el crédito de origen sigue vigente. [Reglas de recuperación](#recuperaciones-fase-06).

## Creación de cursos semanales e inscripción

El formulario **Crear curso semanal** toma la fecha de la primera clase, deduce el día de la semana y calcula el fin en `Europe/Copenhagen`. La vigencia fija empieza en esa fecha y termina el día anterior al aniversario de tres meses. Al guardar se materializan las fechas de ese curso desde el día actual y dentro de la vigencia. El horizonte móvil de tres meses sigue siendo el límite por defecto de cada ejecución periódica y respeta el fin de la plantilla. El formulario **Inscribir alumno** confirma cuántas sesiones quedaron reservadas. Una cancelación de reserva modifica únicamente la fecha cancelada y conserva la inscripción.

## Creación de clases únicas desde administración

En `/admin`, el formulario **Crear clase única** solicita fecha, hora de inicio, duración y aforo. La acción de servidor comprueba el rol y el menor límite entre la normativa vigente y 12 plazas. Tras guardar, el panel muestra la fecha y las horas de la sesión guardada en la zona de Copenhague. La confirmación puede volver a consultarse al recargar la página.

## Alcance implementado

- Perfiles de alumno (`student_profiles`) vinculados a usuarios `STUDENT`.
- Plantillas semanales recurrentes (`class_templates`).
- Sesiones concretas materializadas (`class_sessions`).
- Asignaciones de horarios habituales (`student_template_assignments`).
- Reservas de sesiones (`class_reservations`).
- Bloqueos administrativos de plazas (`session_capacity_blocks`).
- Servicio de disponibilidad y reserva transaccional.
- Comando técnico para generar sesiones recurrentes.
- Cancelaciones versionadas de reservas (`reservation_cancellations`) con clasificación temporal y evaluación de secuencia.
- Registro/corrección de asistencia (`reservation_attendance_records`) con trazabilidad por supersesión.
- Detección idempotente de ausencias para sesiones finalizadas.
- Ledger de créditos (`credit_ledger_movements`) con generación automática, concesión/retiro manual y caducidad.
- Reservas de recuperación (`origin = MAKEUP`) con consumo FIFO y devoluciones según política de cancelación.
- Normativa académica configurable, versionada y auditable, visible en `/normativa`.

## Tablas y relaciones

### `student_profiles`

- Relación 1:1 con `users` vía `user_id` único.
- Solo usuarios `STUDENT` deben tener perfil (validado en aplicación).

### `class_templates`

- Define recurrencia semanal:
  - día ISO (`iso_weekday`, 1..7),
  - hora local (`starts_at_local_time`),
  - duración (`duration_minutes`),
  - vigencia (`effective_from` / `effective_to`),
  - estado (`ACTIVE` / `INACTIVE`),
  - capacidad máxima configurable.

### `class_sessions`

- Ocurrencias concretas con:
  - fecha local,
  - inicio/fin UTC,
  - estado (`SCHEDULED`, `CANCELLED`, `COMPLETED`),
  - capacidad aplicada.
- Pueden tener `template_id` nulo para clases puntuales.
- Índice único parcial por (`template_id`, `local_date`) para evitar duplicados de recurrencia.

### `student_template_assignments`

- Asigna alumnos a plantillas habituales con vigencia temporal.
- Índice único parcial para evitar duplicados activos del mismo alumno+plantilla.

### `class_reservations`

- Reserva de alumno en sesión.
- Estado (`CONFIRMED`, `CANCELLED`) y origen (`ORDINARY`, `MAKEUP`).
- Incluye trazabilidad de cancelación (`cancelled_at`, `cancelled_by_user_id`).
- Índice único parcial para impedir reservas activas duplicadas por alumno+sesión.

### `session_capacity_blocks`

- Bloqueo administrativo de plazas por sesión.
- `blocked_spots` consumen capacidad.
- Se conserva historial con `is_active`.

### `reservation_cancellations`

- Snapshot de cada cancelación aplicada sobre una reserva.
- Incluye:
  - tipo temporal (`ON_TIME` / `LATE`),
  - cumplimiento de regla de 7 días,
  - posición en secuencia de cancelaciones habituales,
  - elegibilidad candidata a recuperación (`can_generate_credit_candidate`) y causa de no elegibilidad.
- Se mantiene histórico completo para futuras fases de ledger/créditos.

### `reservation_attendance_records`

- Registro auditable de asistencia por reserva:
  - `ATTENDED`, `ABSENT`.
- Soporta corrección administrativa sin borrar historial:
  - el registro anterior queda superseded (`superseded_by` + `superseded_at`),
  - el nuevo registro queda como vigente.

### `credit_ledger_movements`

- Ledger inmutable de movimientos de créditos.
- Tipos actuales:
  - `AUTO_CANCELLATION_GRANT`,
  - `MANUAL_GRANT`,
  - `MANUAL_WITHDRAWAL`,
  - `EXPIRATION`.
- Se reservaron tipos para próximas fases:
  - `RECOVERY_CONSUMPTION`,
  - `RECOVERY_REFUND`.
- Cada movimiento guarda trazabilidad de:
  - alumno,
  - cantidad,
  - motivo,
  - administrador (si aplica),
  - referencia de sesión (si aplica),
  - evento origen (cancelación o movimiento fuente),
  - clave de idempotencia.
- Para recuperaciones:
  - `related_reservation_id` (reserva asociada),
  - `source_grant_movement_id` (crédito origen consumido),
  - `source_movement_id` (consumo origen de una devolución),
  - `refund_restored_credit` (si la devolución restaura saldo o solo deja auditoría).

## Generación de sesiones recurrentes

Servicio en `src/application/academic/academic-service.ts`:

- Genera horizonte de 3 meses (configurado en dominio).
- Ignora plantillas inactivas.
- Respeta vigencia de plantilla.
- Inserta con `on conflict do nothing` para idempotencia.
- No altera sesiones existentes (incluidas editadas/canceladas).
- Si omite una sesión futura programada que ya existe, vuelve a comprobar el aforo y reporta el mismo identificador mientras queden más alumnos habituales sin reserva que plazas libres.
- Para cada sesión futura nueva, reserva en la misma transacción a los alumnos cuya asignación cubre la fecha local. Los intervalos incluyen ambos extremos y las asignaciones solapadas del mismo alumno cuentan una vez.
- La sesión y las nuevas reservas guardan la versión de normativa aplicada. La transacción usa el aforo vigente, las reservas confirmadas y los bloqueos activos. Si el grupo no cabe, la sesión se conserva sin reservar a ningún alumno del grupo y el generador informa del conflicto.

Comando CLI:

```bash
npm run academic:generate-sessions
```

El CLI interpreta las fechas PostgreSQL `DATE` y las cadenas ISO como fechas de calendario. Los valores `Date` del driver representan medianoche en la zona del proceso. El CLI conserva ese día y calcula el inicio de la clase en Copenhague.

## Zona horaria y DST

- Zona oficial: `Europe/Copenhagen`.
- Recurrencia calculada en hora local y luego convertida a UTC.
- Estrategia en horas inexistentes por salto DST:
  - avanzar al siguiente minuto local válido (determinista).
- Las horas ambiguas mantienen la resolución determinista de Luxon en la zona del centro.

## Disponibilidad

Fórmula:

`disponibles = max(0, min(capacidad_de_sesión, aforo_vigente) - reservas_confirmadas - plazas_bloqueadas)`

- nunca negativa,
- calculada en servidor con datos de PostgreSQL,
- sin confiar en datos del cliente.
- El aforo máximo inicial es de 12 plazas. Una reducción entra en vigor para nuevas reservas y bloqueos y conserva los compromisos existentes.

## Concurrencia en reservas

La creación de reserva usa transacción con bloqueo de fila (`FOR UPDATE`) sobre `class_sessions`:

1. Bloquea sesión.
2. Verifica estado reservable.
3. Cuenta reservas confirmadas + plazas bloqueadas.
4. Inserta reserva si hay capacidad.

Esto evita sobreventa de la última plaza por carreras concurrentes.

## Cancelaciones y secuencias

- La cancelación de reserva solo aplica sobre reservas confirmadas y actor autorizado.
- Clasificación temporal:
  - `ON_TIME`: cancelación con la antelación de la versión vigente. La versión inicial exige 7 días naturales entre la fecha local de cancelación y la fecha local de la clase.
  - `LATE`: antelación inferior al umbral. Libera la plaza, cuenta en la racha habitual y queda sin crédito.
- Secuencia habitual:
  - solo considera reservas de origen `ORDINARY`,
  - la asistencia efectiva (`ATTENDED`) reinicia la racha,
  - una falta sin aviso (`ABSENT`) se registra, mantiene la racha y deja el saldo intacto,
  - la 3.ª cancelación `ON_TIME` queda candidata a recuperación,
  - desde la 4.ª cancelación consecutiva ya no genera candidato.
  - la racha se evalúa en el orden de celebración. Si una cancelación fuera de orden ocupa el tercer lugar de una racha que ya tiene una concesión, se registra la nueva decisión y se conserva la concesión previa.
- Cada evaluación se registra en la transacción de cancelación con la versión aplicada. Las correcciones de asistencia se tienen en cuenta para las decisiones siguientes.
- El código y la documentación anteriores contaban 168 horas y reiniciaban la racha con `ABSENT`. Los resultados de esas operaciones se conservan como se registraron.

La [especificación general](../planificacion_general.md#cancelaciones-consecutivas) difiere en dos puntos que quedan por conciliar.

- La especificación permite que las tres primeras cancelaciones consecutivas generen crédito. El código vigente solo evalúa como candidata la tercera, antes de aplicar los demás límites.
- La especificación indica que una ausencia rompe la racha. El código vigente mantiene la racha ante `ABSENT` y la reinicia con una asistencia efectiva.

Ambos casos se evalúan en [`evaluateCancellationSequence`](../src/domain/academic/cancellation-rules.ts). La fase 7 usa créditos ya concedidos para verificar las recuperaciones y conserva las reglas de concesión y los movimientos históricos.

## Registro y corrección de asistencia

- `SUPER_ADMIN` puede registrar asistencia o ausencia desde el instante exacto de `ends_at_utc`, incluida la hora de fin de una sesión reprogramada. El servidor compara ese instante con su propio reloj. Las fechas de la sesión siguen las convenciones de `Europe/Copenhagen` del modelo académico.
- El alta y la corrección exigen `classSessionId` y `reservationId`. Bajo bloqueo se comprueba que la reserva pertenece a esa sesión, está confirmada y carece de cancelación, y que la sesión sigue sin cancelar. La API acepta `PRESENT` y su equivalente existente `ATTENDED`. PostgreSQL conserva `ATTENDED` y `ABSENT`.
- Repetir el alta con el mismo resultado vigente devuelve el identificador original. Cambiarlo requiere una corrección con motivo de 3 a 300 caracteres después de recortar espacios. La corrección exige un resultado anterior y rechaza repetir el vigente. Cada versión guarda resultado, reserva, actor, hora, normativa aplicada, motivo y referencia a la versión sustituida cuando corresponda.
- Las escrituras manuales bloquean sesión, reserva y perfil en ese orden. La corrección marca la versión anterior como sustituida e inserta la nueva dentro de la misma transacción. El índice parcial asegura un único resultado vigente por reserva.
- Si la cancelación de la sesión o de la reserva se confirma primero, el alta y la corrección se rechazan. Si hay un resultado vigente, se rechazan la cancelación de esa reserva, la cancelación de su sesión y los cambios del horario de esa sesión. Las cancelaciones tardías siguen siendo cancelaciones. Ante datos históricos que combinan ambos estados, el historial de clases muestra la cancelación y los registros originales quedan disponibles para auditoría.
- Registrar y corregir asistencia o ausencia deja intacto el ledger. La racha conserva su lógica actual. Cambiar entre `ATTENDED` y `ABSENT` puede influir en futuras evaluaciones de la racha, según se explica en [Cancelaciones y secuencias](#cancelaciones-y-secuencias).
- El detalle administrativo incluye **Control de asistencia**. La consulta trae el resultado vigente junto con cada reserva y conserva las cancelaciones en su historial. El formulario aparece al consultar una sesión elegible y vuelve a cargar sus resultados tras guardar. La corrección ofrece el resultado alternativo y usa las mismas garantías del servicio. [Cobertura y pruebas](testing.md#incremento-92--control-de-asistencia-en-el-detalle-de-sesión)

## Detección de ausencias

- Para reservas confirmadas sin cancelación ni resultado vigente de sesiones finalizadas, la operación existente inserta `ABSENT`. La acción de servidor usa su propio reloj. El servicio admite un corte anterior y limita los cortes futuros al instante actual.
- La detección bloquea en orden de identificador las sesiones con candidatas y vuelve a leer las reservas después de adquirir los bloqueos. Así comparte la exclusión con las cancelaciones y el registro manual. Su activación automática queda pendiente.
- La operación es idempotente por reserva y evita duplicados bajo reintentos.
- La generación de identificadores de asistencia automática se hace en aplicación (sin dependencia de extensiones PostgreSQL como `pgcrypto`).

## Créditos

- Integración automática:
  - al cancelar, si la cancelación queda como candidata elegible, se intenta generar crédito automático en la misma transacción.
- Reglas aplicadas:
  - límite inicial de 2 créditos automáticos por alumno y mes natural de cancelación en `Europe/Copenhagen`,
  - la concesión manual no consume ese límite,
  - idempotencia por cancelación para evitar duplicados.
- Caducidad:
  - cada `AUTO_CANCELLATION_GRANT` guarda la caducidad calculada con la versión de la cancelación, inicialmente 6 meses,
  - `EXPIRATION` descuenta solo el remanente de la concesión al vencer. Los créditos ya consumidos quedan registrados en su movimiento de consumo,
  - la disponibilidad se calcula por concesión desde el ledger. Una caducidad histórica se aplica al crédito de origen sin afectar otras concesiones.
- Gestión manual (`SUPER_ADMIN`):
  - concesión de créditos (`MANUAL_GRANT`) con motivo obligatorio,
  - retirada de créditos (`MANUAL_WITHDRAWAL`) con motivo obligatorio,
  - rechazo de retirada por encima del saldo disponible.

## Recuperaciones (Fase 06)

- Una recuperación es una reserva con `origin = MAKEUP`.
- Requisitos de reserva:
  - sesión futura en estado `SCHEDULED`,
  - capacidad disponible real (reservas + bloqueos),
  - sin reserva activa duplicada del alumno en la sesión,
  - límite inicial de 2 recuperaciones confirmadas por mes natural de la sesión (`Europe/Copenhagen`), evaluado con la versión vigente al reservar,
  - crédito FIFO disponible.
- Consumo:
  - al confirmar se crea `RECOVERY_CONSUMPTION` en la misma transacción que la reserva.
  - selección FIFO: menor caducidad, luego menor fecha de generación, luego identificador estable.
  - una reserva ordinaria activa produce un conflicto al solicitar una recuperación para la misma sesión. Un reintento recupera la reserva y su consumo. Si envía una clave de idempotencia, debe ser la clave original.
- Cancelación de recuperación:
  - con la antelación de la versión vigente al cancelar, inicialmente 7 días naturales, se crea `RECOVERY_REFUND`.
    - restaura saldo solo si el crédito origen seguía vigente;
    - si ya caducó, se registra devolución auditable sin restaurar saldo.
  - con una antelación inferior se libera la plaza y el consumo permanece.
- Cancelación administrativa de sesión:
  - el cambio a `CANCELLED` se solicita mediante la operación específica de cancelación administrativa y queda registrado con la versión aplicada.
  - se cancelan recuperaciones confirmadas y se aplica devolución auditable bajo la misma regla de vigencia.
  - la operación es transaccional: si falla una devolución, no se confirma la cancelación de sesión.
  - cada devolución mantiene referencia al consumo origen y al crédito origen (`source_movement_id`, `source_grant_movement_id`).
  - no se duplican devoluciones ante reintentos.
- Ausencia:
  - no devuelve crédito ni genera crédito automático.

## Reprogramación de sesiones y recuperaciones

- Al editar una sesión se recalcula `local_date` desde `starts_at_utc` en `Europe/Copenhagen`.
- El cómputo mensual de recuperaciones usa siempre el mes de la fecha actual de la sesión (`class_sessions.local_date`).
- Si una reprogramación mueve una sesión con reservas `MAKEUP` a otro mes y provoca que algún alumno supere el límite mensual vigente, la reprogramación se rechaza con un error de conflicto.
- No se alteran movimientos históricos del ledger durante reprogramaciones.

## Actualización operativa (fase 06.3.2.13+)

- La asignación habitual (`student_template_assignments`) ahora integra reserva automática de sesiones ya materializadas cuando:
  - la sesión está `SCHEDULED`,
  - pertenece a la misma plantilla,
  - cae dentro de la vigencia de la asignación,
  - es futura (`starts_at_utc >= now()`),
  - existe capacidad disponible real.
- Se evita crear duplicados de reserva activa para el mismo alumno y sesión.
- La operación mantiene control administrativo (`SUPER_ADMIN`) y se ejecuta en transacción.

## Siguiente tarea de generación de sesiones

Durante la generación y sus reintentos, el servicio devuelve las sesiones afectadas dentro del horizonte en `habitualCapacityConflicts` y el CLI imprime sus identificadores. La prioridad entre alumnos elegibles sigue pendiente para una futura asignación automática.

Para localizar sesiones concretas fuera de ese informe, consultar `class_sessions` y cruzar plantilla y fecha local con las asignaciones vigentes de alumnos activos. Contar alumnos distintos sin reserva confirmada y comparar con el aforo efectivo menos las reservas confirmadas y los bloqueos activos.

La revisión en solo lectura encontró un único conflicto entre las cinco sesiones de TEST. La sesión del 13 de enero de 2099 coincide con la fixture de `habitual-assignment.integration.test.ts` en plantilla, fechas asociadas, aforo y reservas. Hay una reserva confirmada, cero bloqueos y un alumno habitual pendiente para una capacidad de una plaza. Ninguna sesión excede el aforo contando solo reservas confirmadas y bloqueos. DEV local no contiene sesiones.

`SUPER_ADMIN` dispone de las acciones de servidor `createReservationAction` para asignar una plaza ordinaria disponible y `updateClassSessionAction` para ampliar el aforo si procede dentro del máximo vigente. La edición queda registrada. El panel actual permite inscribir en un curso o clase única. La vista de incidencias y la resolución manual de sesiones recurrentes desde el panel quedan para la fase 9 del [plan general](../planificacion_general.md). El desempate automático requiere una decisión propia. El generador conserva las reservas existentes.
